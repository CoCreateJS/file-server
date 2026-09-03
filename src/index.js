/********************************************************************************
 * Copyright (C) 2026 CoCreate and Contributors.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 *
 ********************************************************************************/

// Commercial Licensing Information:
// For commercial use of this software without the copyleft provisions of the AGPLv3,
// you must obtain a commercial license from CoCreate LLC.
// For details, visit <https://cocreate.app/licenses/> or contact us at sales@cocreate.app.

import * as render from '@cocreate/server-side-render';
import * as sitemap from '@cocreate/sitemap';
import config from '@cocreate/config';
import { dotNotationToObject } from '@cocreate/utils';

// Module-level reference injected during boot to prevent ESM circular loops
let server = null;

// Module default configuration
let fileServerConfig = {
    defaultCacheControl: 'public, max-age=3600',
    enableSitemapCheck: true,
    enableThemeDetection: true
};

/**
 * Loads file server configuration using @cocreate/config and queries database overrides
 * for 'fileServer' configurations.
 * 
 * @returns {Promise<Object>} Resolved configuration object
 */
async function loadConfig() {
    const sysConfig = await config.get('fileServer');

    let dbConfig = null;
    if (server && server.organization_id) {
        dbConfig = await config.query({
            type: 'fileServer',
            organization_id: server.organization_id,
            server: server.host,
            cluster: server.cluster_id
        });
    }

    if (sysConfig) {
        dotNotationToObject(fileServerConfig, sysConfig);
    }

    if (dbConfig) {
        dotNotationToObject(fileServerConfig, dbConfig);
    }

    return fileServerConfig;
}

/**
 * Main entry point for the CoCreate File System request handler.
 * Handles urlObject parsing, organization lookups, localization, theme detection, and rendering.
 * 
 * @param {Object} req - Native Node HTTP request object
 * @param {Object} res - Native Node HTTP response object
 */
async function send(req, res) {
    try {
        const activeCrud = server ? server.crud : null;
        
        // Parse the URL structure internally from the incoming request
        const urlObject = new URL(`http://${req.headers.host || 'localhost'}${req.url}`);
        const hostname = urlObject.hostname;
        let pathname = urlObject.pathname;

        // Resolve Organization dynamically from the injected CRUD instance
        let organization = null;
        if (activeCrud) {
            try {
                organization = await activeCrud.getOrganization({ host: hostname });
            } catch (err) {
                console.error("[@cocreate/file-server] Failed to resolve organization details internally:", err);
            }
        }

        // 1. Check Organization active status
        if (!organization || organization.error) {
            const hostNotFound = await getDefaultFile({ fileName: "/hostNotFound.html", hostname, organizationId: null, crud: activeCrud });
            sendResponse({
                res,
                src: hostNotFound.object[0].src,
                statusCode: 404,
                headers: { "Content-Type": hostNotFound.object[0]["content-type"] || "text/html" },
                file: hostNotFound.object[0],
                organizationId: null,
                crud: activeCrud
            });
            return;
        }

        const organizationId = organization._id;
        res.setHeader("organization", organizationId);
        res.setHeader("storage", !!organization.storage);
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

        const wsManager = server ? server.wsManager : null;
        const active = wsManager ? wsManager.organizations.get(organizationId) : true;
        if (active === false) {
            const balanceFalse = await getDefaultFile({ fileName: "/balanceFalse.html", hostname, organizationId, crud: activeCrud });
            sendResponse({
                res,
                src: balanceFalse.object[0].src,
                statusCode: 403,
                headers: {
                    "Content-Type": balanceFalse.object[0]["content-type"] || "text/html",
                    "Account-Balance": "false",
                    storage: organization.storage
                },
                file: balanceFalse.object[0],
                organizationId,
                crud: activeCrud
            });
            return;
        }

        // 2. Trailing Slash Redirect
        if (handleTrailingSlash(pathname, urlObject, res)) {
            return; // Redirect occurred, execution halted
        }

        // 3. Theme Detection
        const theme = fileServerConfig.enableThemeDetection ? detectTheme(req, res) : null;

        // 4. Resolve exact file resource and status code
        const { file, src, statusCode, resolvedPathname } = await resolveFile({
            pathname,
            hostname,
            organizationId,
            crud: activeCrud
        });

        // 5. Language Localization Matching
        const { lang, langRegion } = parseLanguage(resolvedPathname, req?.headers);
        const state = req?.headers?.["x-state"] || req?.headers?.state;

        let contentType = file?.["content-type"] || "text/html";

        // 6. Output Normalization and Rendering
        const finalSrc = await normalizeSrc({
            src,
            contentType,
            pathname: resolvedPathname,
            file,
            organization,
            urlObject,
            langRegion,
            lang,
            theme,
            state,
            crud: activeCrud
        });

        let modifiedOn = file?.modified || file?.created;
        if (modifiedOn) {
            modifiedOn = modifiedOn.on;
            if (modifiedOn instanceof Date) {
                modifiedOn = modifiedOn.toISOString();
            }
            res.setHeader("Last-Modified", modifiedOn);
        }

        // 7. Send final response
        sendResponse({
            res,
            src: finalSrc,
            statusCode,
            headers: { "Content-Type": contentType },
            file,
            organizationId: organizationId,
            crud: activeCrud,
            organizationCacheControl: organization["cache-control"]
        });

        // 8. Async Sitemap Check
        if (fileServerConfig.enableSitemapCheck && file) {
            await sitemap.check({ file, host: hostname, crud: activeCrud });
        }

    } catch (error) {
        console.error("Critical error in FileSystem handler:", error);
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Invalid host format");
    }
}

/**
 * Normalizes slash-ending paths, resolves files via wildcard mappings,
 * handles 404/403 fallbacks, and fetches asset sources.
 */
async function resolveFile({ pathname, hostname, organizationId, crud }) {
    const activeCrud = crud || (server ? server.crud : null);
    let statusCode = 200;
    let file;

    if (pathname.endsWith("/")) {
        pathname += "index.html";
    }

    const queryData = {
        method: "object.read",
        host: hostname,
        array: "files",
        organization_id: organizationId,
        filter: {
            query: {
                host: { $in: [hostname, "*"] },
                pathname
            },
            limit: 1
        }
    };

    // 1. Fetch File
    if (
        pathname.startsWith("/dist") ||
        pathname.startsWith("/admin") ||
        [
            "/403.html",
            "/404.html",
            "/offline.html",
            "/manifest.webmanifest",
            "/service-worker.js"
        ].includes(pathname)
    ) {
        const defaultResult = await getDefaultFile({ fileName: pathname, hostname, organizationId, crud: activeCrud });
        file = defaultResult?.object?.[0];
    } else {
        const result = await activeCrud.send(queryData);
        file = result?.object?.[0];
    }

    // 2. Wildcard fallback
    if (!file) {
        const wildcardPath = getWildcardPath(pathname);
        queryData.filter.query.pathname = wildcardPath;
        const result = await activeCrud.send(queryData);
        file = result?.object?.[0];
    }

    // 3. Fallback to 404 if file completely missing
    if (!file) {
        statusCode = 404;
        const pageNotFound = await getDefaultFile({ fileName: "/404.html", hostname, organizationId, crud: activeCrud });
        file = pageNotFound?.object?.[0];
    }

    // 4. Fallback to 403 if not public
    if (file && (!file["public"] || file["public"] === "false")) {
        statusCode = 403;
        const pageForbidden = await getDefaultFile({ fileName: "/403.html", hostname, organizationId, crud: activeCrud });
        file = pageForbidden?.object?.[0];
    }

    // 5. Fetch file source markup
    let src = file?.src || "";
    if (file && !file["src"]) {
        try {
            const fileSrc = await activeCrud.send({
                method: "object.read",
                host: hostname,
                array: file["array"],
                object: { _id: file._id },
                organization_id: organizationId
            });
            src = fileSrc?.[file["name"]] || "";
        } catch (err) {
            console.error("Error fetching file src:", err);
        }
    }

    // 6. Ultimate 404 payload fallback if source resolves empty
    if (!src && file) {
        statusCode = 404;
        const pageNotFound = await getDefaultFile({ fileName: "/404.html", hostname, organizationId, crud: activeCrud });
        file = pageNotFound?.object?.[0];
        src = file?.src || "";
    }

    // Bind source markup and calculated status directly onto the file document for downstream consumers
    if (file) {
        file.src = src;
        file.status = statusCode;
    }

    return { file, src, statusCode, resolvedPathname: pathname };
}

/**
 * Specifically resolves, tracks, and mirrors system fallbacks from global scopes.
 */
async function getDefaultFile({ fileName, hostname, organizationId, crud }) {
    const activeCrud = crud || (server ? server.crud : null);
    const queryData = {
        method: "object.read",
        host: hostname,
        array: "files",
        organization_id: organizationId,
        filter: {
            query: {
                host: { $in: [hostname, "*"] },
                pathname: fileName
            },
            limit: 1
        }
    };

    let defaultFile;
    if (fileName !== "/hostNotFound.html" && organizationId) {
        defaultFile = await activeCrud.send(queryData);
    }

    if (defaultFile?.object?.[0]?.src) {
        return defaultFile;
    }

    // Search global scope platform database
    queryData.filter.query.host.$in = ["*"];
    queryData.organization_id = process.env.organization_id;

    if (fileName.startsWith("/admin")) {
        queryData.filter.query.pathname = "/superadmin" + fileName.replace("/admin", "");
    }

    defaultFile = await activeCrud.send(queryData);

    if (fileName !== "/hostNotFound.html" && organizationId) {
        process.emit("usage", {
            type: "egress",
            data: queryData,
            organization_id: organizationId
        });

        process.emit("usage", {
            type: "ingress",
            data: defaultFile,
            organization_id: organizationId
        });
    }

    if (defaultFile?.object?.[0]?.src) {
        if (fileName.startsWith("/admin")) {
            defaultFile.object[0].directory = "admin";
            defaultFile.object[0].path = "/admin" + defaultFile.object[0].path.replace("/superadmin", "");
            defaultFile.object[0].pathname = fileName;
        }

        if (organizationId) {
            // Save local cloned copy inside this organization's database
            await activeCrud.send({
                method: "object.create",
                host: hostname,
                array: "files",
                object: defaultFile.object[0],
                organization_id: organizationId
            });
        }

        return defaultFile;
    }

    // Hard fallback definitions in case DB collections are empty
    const structuralFallback = { object: [{ src: "" }] };
    switch (fileName) {
        case "/403.html":
            structuralFallback.object[0].src = `Access not allowed for ${organizationId}`;
            break;
        case "/404.html":
            structuralFallback.object[0].src = `File could not be found for ${organizationId}`;
            break;
        case "/balanceFalse.html":
            structuralFallback.object[0].src = "This organization's account balance has fallen below 0: ";
            break;
        case "/hostNotFound.html":
            structuralFallback.object[0].src = `An organization could not be found using the host: ${hostname} in platformDB: ${process.env.organization_id}`;
            break;
    }
    return structuralFallback;
}

/**
 * Calculates a directory wildcard path pattern representation.
 */
function getWildcardPath(pathname) {
    const lastIndex = pathname.lastIndexOf("/");
    const wildcardPath = pathname.substring(0, lastIndex + 1);
    const wildcardName = pathname.substring(lastIndex + 1);

    if (wildcardName.includes(".")) {
        const fileLastIndex = wildcardName.lastIndexOf(".");
        const fileExtension = wildcardName.substring(fileLastIndex);
        return wildcardPath + "*" + fileExtension;
    } else {
        return wildcardPath + "*/index.html";
    }
}

/**
 * Detects color scheme from HTTP headers and updates client indicators.
 */
function detectTheme(req, res) {
    let theme;
    const headerValue = req?.headers && (
        req.headers["sec-ch-prefers-color-scheme"] ||
        req.headers["prefers-color-scheme"] ||
        req.headers["x-prefers-color-scheme"] ||
        req.headers["x-color-scheme"]
    );
    if (typeof headerValue === "string") {
        const token = headerValue.split(",")[0].trim().replace(/^"|"$/g, "").toLowerCase();
        if (token === "dark" || token === "light") {
            theme = token;
        }
    }
    if (theme && res) {
        res.setHeader("X-Preferred-Color-Scheme", theme);
    }
    return theme;
}

/**
 * Standardizes directory matching redirection configurations.
 */
function handleTrailingSlash(pathname, urlObject, res) {
    if (!pathname.endsWith("/") && !pathname.startsWith("/.well-known/acme-challenge")) {
        const lastSegment = pathname.split("/").slice(-1)[0];
        if (!lastSegment.includes(".")) {
            const search = urlObject.search || "";
            res.writeHead(301, { Location: pathname + "/" + search });
            res.end();
            return true;
        }
    }
    return false;
}

/**
 * Extracts explicit or implicit preferred localization tokens from endpoints.
 */
function parseLanguage(pathname, headers) {
    const bcp47Regex = /^\/([a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})?)\//;
    const langMatch = pathname.match(bcp47Regex);
    let lang, langRegion;

    if (langMatch) {
        langRegion = langMatch[1];
        lang = langRegion.split("-")[0];
        const basePathname = pathname.replace("/" + langRegion, "");
        return { lang, langRegion, basePathname };
    }

    const acceptLang = headers?.["accept-language"];
    if (acceptLang) {
        const preferred = acceptLang.split(",")[0].trim();
        if (preferred) {
            lang = preferred.split("-")[0];
            langRegion = preferred;
        }
    }
    return { lang, langRegion, basePathname: pathname };
}

/**
 * Formats, cleans, parses, and executes rendering transformations based on content types.
 */
async function normalizeSrc({ src, contentType, pathname, file, organization, urlObject, langRegion, lang, theme, state, crud }) {
    const activeCrud = crud || (server ? server.crud : null);
    const isBase64Only = (s) =>
        typeof s === "string" && s.length > 0 && /^[A-Za-z0-9+/=\-_]+$/.test(s.replace(/\s+/g, '')) && s.replace(/\s+/g, '').length % 4 === 0;

    const parseDataUri = (s) => {
        const m = /^data:([^;]+)(;base64)?,(.*)$/is.exec(s);
        if (!m) return null;
        return { mime: m[1].toLowerCase(), isBase64: !!m[2], data: m[3] };
    };

    // Fonts
    if (contentType.startsWith("font/") || /\.(woff2?|ttf|otf)$/i.test(pathname)) {
        if (Buffer.isBuffer(src)) return src;
        if (typeof src !== "string") return Buffer.from("");
        
        const cleanedSrc = src.trim();
        const d = parseDataUri(cleanedSrc);
        if (d?.isBase64) {
            return Buffer.from(d.data.replace(/\s+/g, ''), "base64");
        }

        const stripped = cleanedSrc.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
        if (isBase64Only(stripped)) {
            return Buffer.from(stripped, "base64");
        }

        // Graceful fallback for binary or raw font strings instead of throwing
        try {
            return Buffer.from(src, "binary");
        } catch (_) {
            return Buffer.from(src);
        }
    }

    // Data URIs
    if (typeof src === "string") {
        const d = parseDataUri(src);
        if (d) {
            if (d.mime === "image/svg+xml") {
                if (d.isBase64) return Buffer.from(d.data, "base64").toString("utf8");
                try {
                    return decodeURIComponent(d.data);
                } catch (_) {
                    return d.data;
                }
            }
            if (/^(image\/(png|jpe?g|webp|bmp|gif|x-icon|vnd\.microsoft\.icon|ico)|video\/.*|audio\/.*)$/i.test(d.mime)) {
                if (d.isBase64) return Buffer.from(d.data, "base64");
            }
            if (!d.isBase64) {
                try {
                    return decodeURIComponent(d.data);
                } catch (_) {
                    return d.data;
                }
            }
        }
    }

    // Plain base64-only string
    if (isBase64Only(src)) {
        if (
            contentType.startsWith("image/") ||
            contentType.startsWith("font/") ||
            contentType.startsWith("video/") ||
            contentType.startsWith("audio/") ||
            contentType === "application/octet-stream"
        ) {
            return Buffer.from(src, "base64");
        }
        return src;
    }

    // HTML rendering
    if (contentType === "text/html") {
        const recursiveResolve = async (nestedPathname) => {
            const resolved = await resolveFile({
                pathname: nestedPathname,
                hostname: urlObject.hostname,
                organizationId: organization._id,
                crud: activeCrud
            });
            return resolved?.file || null;
        };

        return await render.HTML({
            file,
            organization,
            urlObject,
            langRegion,
            lang,
            theme,
            state,
            resolveFile: recursiveResolve,
            crud: activeCrud
        });
    }

    // XML host replacement
    if ((contentType === "text/xml" || contentType === "application/xml") && typeof src === "string") {
        const protocol = "https://";
        return src.replaceAll("{{$host}}", `${protocol}${urlObject.hostname}`);
    }

    return src;
}

/**
 * Handles setting response headers, caching guidelines, bandwidth tracking, and returning binary strings.
 */
async function sendResponse({ res, src, statusCode, headers, file, organizationId, crud, organizationCacheControl }) {
    try {
        const responseHeaders = { ...headers };
        const getHeaderKey = (name) => Object.keys(responseHeaders)
            .find((key) => key.toLowerCase() === name.toLowerCase());
        const getHeader = (name) => {
            const key = getHeaderKey(name);
            return key ? responseHeaders[key] : undefined;
        };
        const setHeader = (name, value) => {
            const key = getHeaderKey(name);
            if (key && key !== name) delete responseHeaders[key];
            responseHeaders[name] = value;
        };

        if (file?.headers && typeof file.headers === "object" && !Array.isArray(file.headers)) {
            for (const [name, value] of Object.entries(file.headers)) {
                if (value !== undefined && value !== null) setHeader(name, value);
            }
        }

        let cacheControl;
        if (statusCode >= 400) {
            cacheControl = "no-cache, no-store, must-revalidate";
        } else if (getHeader("Cache-Control") !== undefined) {
            cacheControl = getHeader("Cache-Control");
        } else {
            cacheControl = organizationCacheControl || fileServerConfig.defaultCacheControl || "public, max-age=3600";
        }

        if (typeof cacheControl === "number" || /^\s*\d+\s*$/.test(cacheControl)) {
            cacheControl = `public, max-age=${String(cacheControl).trim()};`;
        }
        setHeader("Cache-Control", cacheControl);
        if (getHeader("Accept-CH") === undefined) {
            setHeader("Accept-CH", "Sec-CH-Prefers-Color-Scheme");
        }
        if (getHeader("Accept-CH-Lifetime") === undefined) {
            setHeader("Accept-CH-Lifetime", "86400");
        }
        const vary = getHeader("Vary");
        setHeader("Vary", vary
            ? vary + ", Sec-CH-Prefers-Color-Scheme"
            : "Sec-CH-Prefers-Color-Scheme"
        );

        if (src instanceof Uint8Array || Buffer.isBuffer(src)) {
            // Binary formats passed directly
        } else if (typeof src === "object") {
            src = JSON.stringify(src);
        }

        if (organizationId) {
            process.emit("usage", {
                type: "egress",
                data: src,
                organization_id: organizationId
            });
        }
        res.writeHead(statusCode, responseHeaders);
        res.end(src);
    } catch (error) {
        console.error("Error finalizing response payload:", error);
    }
}

/**
 * Initializes the FileServer module.
 * 
 * @param {Object} serverInstance - Core server instance
 * @returns {Promise<Object>} FileServer interface object containing methods and config
 */
export async function init(serverInstance) {
    server = serverInstance;

    await loadConfig();

    const fileServer = {
        config: fileServerConfig,
        send,
        resolveFile
    };

    return fileServer;
}

export default { init };
