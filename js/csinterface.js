/**************************************************************************************************
 *
 * ADOBE SYSTEMS INCORPORATED
 * Copyright 2013-2018 Adobe Systems Incorporated
 * All Rights Reserved.
 *
 * NOTICE:  Adobe permits you to use, modify, and distribute this file in accordance with the
 * terms of the Adobe license agreement accompanying it.  If you have received this file from a
 * source other than Adobe, then your use, modification, or distribution of it requires the prior
 * written permission of Adobe.
 *
 **************************************************************************************************/

/** CEP Interface - SmartEdit Pro bundled copy of CSInterface 11.x.
 *  Full reference: https://github.com/Adobe-CEP/CEP-Resources
 *  This is a trimmed but functional subset that supports the APIs the panel uses
 *  (evalScript, getHostEnvironment, getSystemPath, addEventListener, dispatchEvent,
 *   getApplicationID, openURLInDefaultBrowser, requestOpenExtension, etc.).
 */

function SystemPath() {}
SystemPath.USER_DATA = "userData";
SystemPath.COMMON_FILES = "commonFiles";
SystemPath.MY_DOCUMENTS = "myDocuments";
SystemPath.APPLICATION = "application";
SystemPath.EXTENSION = "extension";
SystemPath.HOST_APPLICATION = "hostApplication";

function CSEvent(type, scope, appId, extensionId) {
    this.type = type;
    this.scope = scope;
    this.appId = appId;
    this.extensionId = extensionId;
    this.data = "";
}

function HostEnvironment(appName, appVersion, appLocale, appUILocale, appId, isAppOnline, appSkinInfo) {
    this.appName = appName;
    this.appVersion = appVersion;
    this.appLocale = appLocale;
    this.appUILocale = appUILocale;
    this.appId = appId;
    this.isAppOnline = isAppOnline;
    this.appSkinInfo = appSkinInfo;
}

function CSInterface() {
    this.hostEnvironment = (typeof window !== "undefined" && window.__adobe_cep__)
        ? JSON.parse(window.__adobe_cep__.getHostEnvironment())
        : new HostEnvironment("PPRO", "23.0.0", "en_US", "en_US", "PPRO", true, null);
}

/**
 * Main API - evaluate ExtendScript code in the host application.
 * @param {string} script   ExtendScript source.
 * @param {function(string)} [callback]  Receives the result (string) or "EvalScript error.".
 */
CSInterface.prototype.evalScript = function (script, callback) {
    if (callback === null || callback === undefined) {
        callback = function () {};
    }
    if (typeof window !== "undefined" && window.__adobe_cep__) {
        window.__adobe_cep__.evalScript(script, callback);
    } else {
        // Browser fallback: pretend the script returned an error so the caller
        // sees a sensible message when the panel is loaded outside of CEP.
        callback("EvalScript error.");
    }
};

CSInterface.prototype.getHostEnvironment = function () {
    return this.hostEnvironment;
};

CSInterface.prototype.getSystemPath = function (pathType) {
    if (typeof window !== "undefined" && window.__adobe_cep__) {
        var path = window.__adobe_cep__.getSystemPath(pathType);
        var OSVersion = this.getOSInformation();
        if (OSVersion.indexOf("Windows") >= 0) {
            path = path.replace("file:///", "");
        } else if (OSVersion.indexOf("Mac") >= 0) {
            path = path.replace("file://", "");
        }
        return path;
    }
    return "";
};

CSInterface.prototype.getApplicationID = function () {
    return this.hostEnvironment ? this.hostEnvironment.appId : "PPRO";
};

CSInterface.prototype.getOSInformation = function () {
    var userAgent = (typeof navigator !== "undefined") ? navigator.userAgent : "";
    if (userAgent.indexOf("Windows") >= 0) return "Windows";
    if (userAgent.indexOf("Mac") >= 0) return "Mac OS";
    return "Unknown";
};

CSInterface.prototype.addEventListener = function (type, listener, obj) {
    if (typeof window !== "undefined" && window.__adobe_cep__) {
        window.__adobe_cep__.addEventListener(type, listener, obj);
    }
};

CSInterface.prototype.removeEventListener = function (type, listener, obj) {
    if (typeof window !== "undefined" && window.__adobe_cep__) {
        window.__adobe_cep__.removeEventListener(type, listener, obj);
    }
};

CSInterface.prototype.dispatchEvent = function (event) {
    if (typeof event.data === "object") {
        event.data = JSON.stringify(event.data);
    }
    if (typeof window !== "undefined" && window.__adobe_cep__) {
        window.__adobe_cep__.dispatchEvent(event);
    }
};

CSInterface.prototype.requestOpenExtension = function (extensionId, params) {
    if (typeof window !== "undefined" && window.__adobe_cep__) {
        window.__adobe_cep__.requestOpenExtension(extensionId, params || "");
    }
};

CSInterface.prototype.openURLInDefaultBrowser = function (url) {
    if (typeof cep !== "undefined" && cep.util && cep.util.openURLInDefaultBrowser) {
        return cep.util.openURLInDefaultBrowser(url);
    }
};

CSInterface.prototype.closeExtension = function () {
    if (typeof window !== "undefined" && window.__adobe_cep__) {
        window.__adobe_cep__.closeExtension();
    }
};
