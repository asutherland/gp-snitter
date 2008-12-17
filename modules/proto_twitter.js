/* ***** BEGIN LICENSE BLOCK *****
 * Version: MPL 1.1/GPL 2.0/LGPL 2.1
 *
 * The contents of this file are subject to the Mozilla Public License Version
 * 1.1 (the "License"); you may not use this file except in compliance with
 * the License. You may obtain a copy of the License at
 * http://www.mozilla.org/MPL/
 *
 * Software distributed under the License is distributed on an "AS IS" basis,
 * WITHOUT WARRANTY OF ANY KIND, either express or implied. See the License
 * for the specific language governing rights and limitations under the
 * License.
 *
 * The Original Code is Snowl.
 *
 * The Initial Developer of the Original Code is Mozilla.
 * Portions created by the Initial Developer are Copyright (C) 2008
 * the Initial Developer. All Rights Reserved.
 *
 * Contributor(s):
 *   Myk Melez <myk@mozilla.org>
 *   Andrew Sutherland <asutherland@asutherland.org>
 *
 * Alternatively, the contents of this file may be used under the terms of
 * either the GNU General Public License Version 2 or later (the "GPL"), or
 * the GNU Lesser General Public License Version 2.1 or later (the "LGPL"),
 * in which case the provisions of the GPL or the LGPL are applicable instead
 * of those above. If you wish to allow use of your version of this file only
 * under the terms of either the GPL or the LGPL, and not to allow others to
 * use your version of this file under the terms of the MPL, indicate your
 * decision by deleting the provisions above and replace them with the notice
 * and other provisions required by the GPL or the LGPL. If you do not delete
 * the provisions above, a recipient may use your version of this file under
 * the terms of any one of the MPL, the GPL or the LGPL.
 *
 * ***** END LICENSE BLOCK ***** */

/*
 * This module is taken from Snowl (https://hg.mozdev.org/snowl/) and has been
 * modified to fit into a gloda-centric world view.
 */

let EXPORTED_SYMBOLS = ["SnowlTwitter"];

const Cc = Components.classes;
const Ci = Components.interfaces;
const Cr = Components.results;
const Cu = Components.utils;

// modules that come with Firefox
Cu.import("resource://gre/modules/XPCOMUtils.jsm");

// modules that are generic
Cu.import("resource://app/modules/gloda/log4moz.js");

Cu.import("resource://app/modules/gloda/indexer.js");


try {

/**
 * The HTTP authentication realm under which to save credentials via the login
 * manager.  We save them under a realm whose name we define instead of the one
 * that Twitter provides (currently "Twitter API") because we set our own
 * Authorization header, and that happens before we get a response from Twitter,
 * so we can't depend on the value Twitter sets when it responds, because
 * we don't know it yet.
 *
 * Using our own realm also has the beneficial side effect that users browsing
 * their saved credentials in preferences will see our realm next to
 * the credentials that were saved by Snowl, which seems a better explanation
 * of where the credentials come from than the one Twitter provides.
 *
 * The reason we set our own Authorization header is that Necko assumes users
 * will only be logged into a single account for a given authentication realm
 * in any given session, so it caches credentials and reuses them for all
 * requests to the same realm.  Setting the Authorization header ourselves
 * ensures that we determine the credentials being used for our requests,
 * which is necessary to support multiple Twitter accounts.
 *
 * We could have theoretically worked around the problem by putting the username
 * into the URL (i.e. https://username@twitter.com...) and falling back on our
 * notification callback to get the saved credentials, by which point we'd know
 * the authentication realm.
 *
 * But experimentation showed that only worked for serialized requests;
 * concurrent requests (like when we refresh two Twitter accounts at the same
 * time asynchronously) cause Necko to again use the same credentials for both
 * refreshes, even though we've specified different usernames in the URLs
 * for those refreshes.
 *
 * And it had the side-effect that Necko stopped saving credentials at all
 * after the requests completed, so a user with a single account who didn't save
 * their credentials was prompted to enter them every time we refreshed.
 *
 * FIXME: file a bug on this bad behavior of Necko during concurrent requests.
 *
 * We could have also worked around the problem by also injecting the password
 * into the request URLs (i.e. https://username:password@twitter.com...),
 * but then we'd be putting passwords into URLs, which is considered harmful
 * because URLs leak into visible places (like the Error Console).
 */
const AUTH_REALM = "Twitter";

// This module is based on the API documented at http://apiwiki.twitter.com/.

function SnowlTwitter(aUsername) {
  this.username = aUsername;
}

SnowlTwitter.prototype = {
  // because of the way gloda's logging works, we need to use gloda as our root.
  _log: Log4Moz.repository.getLogger("gloda.twitter.proto"),

  //**************************************************************************//
  // SnowlSource

  refreshInterval: 1000 * 60 * 3, // 3 minutes

  name: "Twitter",
  machineURI: Cc["@mozilla.org/network/io-service;1"]
                .getService(Ci.nsIIOService)
                .newURI("https://twitter.com", undefined, undefined),
  humanURI: Cc["@mozilla.org/network/io-service;1"]
              .getService(Ci.nsIIOService)
              .newURI("http://twitter.com/home", undefined, undefined),
  username: null,

  importance: null,

  //**************************************************************************//
  // SnowlTarget

  maxMessageLength: 140,

  // send is defined elsewhere.
  //send: function() {},


  //**************************************************************************//
  // Notification Callbacks for Authentication

  // FIXME: factor this out with the equivalent code in feed.js.

  // If we prompt the user to authenticate, and the user asks us to remember
  // their password, we store the nsIAuthInformation in this property until
  // the request succeeds, at which point we store it with the login manager.
  _authInfo: null,

  /*
  get _loginManager() {
    let loginManager = Cc["@mozilla.org/login-manager;1"].
                       getService(Ci.nsILoginManager);
    this.__defineGetter__("_loginManager", function() loginManager);
    return this._loginManager;
  },
  */

  /**
   * The saved credentials for this Twitter account, if any.
   * FIXME: we memoize this and never refresh it, which won't do once we have
   * long-lived account objects, so don't memoize this at all (attach it to
   * its request and kill it once the request is done) or invalidate it when
   * the set of credentials changes.
   */
  /*
  get _savedLogin() {
    // Alias this.username to a local variable because we can't use "this"
    // in the lambda expression we pass to the filter method below due to
    // bug 469609.
    let username = this.username;

    // XXX Should we be using channel.URI.prePath instead of
    // this.machineURI.prePath in case the old URI redirects us to a new one
    // at a different hostname?
    return this._loginManager.
           findLogins({}, this.machineURI.prePath, null, AUTH_REALM).
           filter(function(login) login.username == username)
           [0];
  },
  */

  // nsISupports

  QueryInterface: XPCOMUtils.generateQI([]), //[Ci.nsIAuthPrompt2]),

  // nsIInterfaceRequestor

  getInterface: function(iid) {
    return this.QueryInterface(iid);
  },

  // nsIAuthPrompt2

  promptAuth: function(channel, level, authInfo) {
    this._log.debug("promptAuth: this.name = " + this.name + "; this.username = " + this.username);
    this._log.debug("promptAuth: this.name = " + this.name + "; authInfo.realm = " + authInfo.realm);

    let args = Cc["@mozilla.org/supports-array;1"].createInstance(Ci.nsISupportsArray);
    args.AppendElement({ wrappedJSObject: this });
    args.AppendElement(authInfo);

    // |result| is how the dialog passes information back to us.  It sets two
    // properties on the object:
    //   |proceed|, which we return from this function, and which determines
    //     whether or not authentication can proceed using the value(s) entered
    //     by the user;
    //   |remember|, which determines whether or not we save the user's login
    //     with the login manager once the request succeeds.
    let result = {};
    args.AppendElement({ wrappedJSObject: result });

    let ww = Cc["@mozilla.org/embedcomp/window-watcher;1"].getService(Ci.nsIWindowWatcher);
    ww.openWindow(null,
                  "chrome://snowl/content/login.xul",
                  null,
                  "chrome,centerscreen,dialog,modal",
                  args);

    if (result.remember)
      this._authInfo = authInfo;
    else
      this._authInfo = null;

    return result.proceed;
  },

  asyncPromptAuth: function() {
    throw Cr.NS_ERROR_NOT_IMPLEMENTED;
  },


  //**************************************************************************//
  // Subscription

  subscribed: false,
  subscribe: function(credentials) {
    this.username = credentials.username;
    this.name = NAME + " - " + this.username;

    // credentials isn't a real nsIAuthInfo, but it's close enough for what
    // we do with it, which is to retrieve the username and password from it
    // and save them via the login manager if the user asked us to remember
    // their credentials.
    if (credentials.remember)
      this._authInfo = credentials;

    let request = Cc["@mozilla.org/xmlextras/xmlhttprequest;1"].createInstance();

    // Add load and error callbacks.
    request.QueryInterface(Ci.nsIDOMEventTarget);
    let t = this;
    request.addEventListener("load", function(e) { t.onSubscribeLoad(e) }, false);
    request.addEventListener("error", function(e) { t.onSubscribeError(e) }, false);

    request.QueryInterface(Ci.nsIXMLHttpRequest);
    request.open("GET", "https://twitter.com/account/verify_credentials.json", true);
    request.setRequestHeader("Authorization", "Basic " + btoa(credentials.username +
                                                              ":" +
                                                              credentials.password));
    request.channel.notificationCallbacks = this;
    request.send(null);
  },

  onSubscribeLoad: function(event) {
    let request = event.target;

    // request.responseText should be: {"authorized":true}
    this._log.info("onSubscribeLoad: " + request.responseText);

    // The load event can fire even with a non 2xx code, so handle as error
    if (request.status < 200 || request.status > 299) {
      this.onSubscribeError(event);
      return;
    }

    // XXX What's the right way to handle this?
    if (request.responseText.length == 0) {
      this.onSubscribeError(event);
      return;
    }

    // _authInfo only gets set if we prompted the user to authenticate
    // and the user checked the "remember password" box.  Since we're here,
    // it means the request succeeded, so we save the login.
    if (this._authInfo)
      this._saveLogin(this._authInfo);

    // Save the source to the database.
    this.persist();
    this.subscribed = true;

    this._resetSubscribeRequest();

    this.refresh(new Date());
  },

  onSubscribeError: function(event) {
    let request = event.target;

    // request.responseText should be: Could not authenticate you.
    this._log.info("onSubscribeError: " + request.responseText);

    // Sometimes an attempt to retrieve status text throws NS_ERROR_NOT_AVAILABLE.
    let statusText;
    try {statusText = request.statusText;} catch(ex) {statusText = "[no status text]"}

    this._log.error("onSubscribeError: " + request.status + " (" + statusText + ")");
    this._resetSubscribeRequest();
  },

  _resetSubscribeRequest: function() {
    this._authInfo = null;
  },


  //**************************************************************************//
  // Refreshment

  // FIXME: create a refresher object that encapsulates the functionality
  // provided by this code, since it creates properties that are essentially
  // global variables (like _authInfo and _refreshTime)
  // and will create concurrency problems with long-lived account objects.

  _refreshTime: null,

  refresh: function(refreshTime) {
    // Cache the refresh time so we can use it as the received time when adding
    // messages to the datastore.
    this._refreshTime = refreshTime;

    let request = Cc["@mozilla.org/xmlextras/xmlhttprequest;1"].createInstance();

    request.QueryInterface(Ci.nsIDOMEventTarget);
    let t = this;
    request.addEventListener("load", function(e) { t.onRefreshLoad(e) }, false);
    request.addEventListener("error", function(e) { t.onRefreshError(e) }, false);

    request.QueryInterface(Ci.nsIXMLHttpRequest);

    // URL parameters that modify the return value of the request
    let params = [];
    // Retrieve up to 200 messages, the maximum we're allowed to retrieve
    // in one request.
    params.push("count=200");
    // Retrieve only messages newer than the most recent one we've previously
    // retrieved.
    /*
    let (maxID = this._getMaxExternalID()) {
      if (maxID)
        params.push("since_id=" + maxID);
    }
    */

    let url = "https://twitter.com/statuses/friends_timeline.json?" + params.join("&");
    this._log.debug("refresh: this.name = " + this.name + "; url = " + url);
    request.open("GET", url, true);

    // If the login manager has saved credentials for this account, provide them
    // to the server.  Otherwise, no worries, Necko will automatically call our
    // notification callback, which will prompt the user to enter their credentials.
    /*
    if (this._savedLogin) {
      let credentials = btoa(this.username + ":" + this._savedLogin.password);
      request.setRequestHeader("Authorization", "Basic " + credentials);
    }
    */

    // Register a callback for notifications to handle authentication failures.
    // We do this whether or not we're providing credentials to the server via
    // the Authorization header, as the credentials we provide via that header
    // might be wrong, so we might need this in any case.
    request.channel.notificationCallbacks = this;

    request.send(null);

    // We set the last refreshed timestamp here even though the refresh
    // is asynchronous, so we don't yet know whether it has succeeded.
    // The upside of this approach is that we don't keep trying to refresh
    // a source that isn't responding, but the downside is that it takes
    // a long time for us to refresh a source that is only down for a short
    // period of time.  We should instead keep trying when a source fails,
    // but with a progressively longer interval (up to the standard one).
    // FIXME: implement the approach described above.
    this.lastRefreshed = refreshTime;
  },

  onRefreshLoad: function(event) {
    let request = event.target;

    // The load event can fire even with a non 2xx code, so handle as error
    if (request.status < 200 || request.status > 299) {
      this.onRefreshError(event);
      return;
    }

    // XXX What's the right way to handle this?
    if (request.responseText.length == 0) {
      this.onRefreshError(event);
      return;
    }

    // _authInfo only gets set if we prompted the user to authenticate
    // and the user checked the "remember password" box.  Since we're here,
    // it means the request succeeded, so we save the login.
    if (this._authInfo) {
      // Fix the name and username attributes of Twitter accounts from earlier
      // versions of Snowl that didn't support multiple accounts (i.e. anything
      // before 0.2pre3).
      if (!this.username) {
        this.username = this._authInfo.username;
        this.name = NAME + " - " + this._authInfo.username;
        this.persist();
      }

      //this._saveLogin(this._authInfo);
    }

    this._processRefresh(request.responseText);
    this._resetRefreshRequest();
  },

  onRefreshError: function(event) {
    let request = event.target;

    // Sometimes an attempt to retrieve status text throws NS_ERROR_NOT_AVAILABLE.
    let statusText;
    try { statusText = request.statusText } catch(ex) { statusText = "[no status text]" }

    this._log.error("onRefreshError: " + request.status + " (" + statusText + ")");
    this._resetRefreshRequest();
  },

  _processRefresh: function(responseText) {
    this._log.debug("_processRefresh: this.name = " + this.name);

    var JSON = Cc["@mozilla.org/dom/json;1"].createInstance(Ci.nsIJSON);
    let messages = JSON.decode(responseText);

    let job = new IndexingJob("tweets", 1);
    job.items = messages;
    GlodaIndexer.indexJob(job);
  },

  _resetRefreshRequest: function() {
    this._refreshTime = null;
    this._authInfo = null;
  },

  // XXX Perhaps factor this out with the identical function in feed.js,
  // although this function supports multiple accounts with the same server
  // and doesn't allow the user to change their username, so maybe that's
  // not possible (or perhaps we can reconcile those differences).
  /*
  _saveLogin: function(authInfo) {
    // Create a new login with the auth information we obtained from the user.
    let LoginInfo = new Components.Constructor("@mozilla.org/login-manager/loginInfo;1",
                                               Ci.nsILoginInfo,
                                               "init");
    // XXX Should we be using channel.URI.prePath in case the old URI
    // redirects us to a new one at a different hostname?
    let newLogin = new LoginInfo(this.machineURI.prePath,
                                 null,
                                 AUTH_REALM,
                                 authInfo.username,
                                 authInfo.password,
                                 "",
                                 "");

    // If there are credentials with the same username, we replace them.
    // Otherwise, we add the new credentials.
    if (this._savedLogin)
      this._loginManager.modifyLogin(this._savedLogin, newLogin);
    else
      this._loginManager.addLogin(newLogin);
  },
  */


  //**************************************************************************//
  // Sending

  _successCallback: null,
  _errorCallback: null,

  send: function(content, successCallback, errorCallback) {
    let data = "status=" + encodeURIComponent(content);
    //          + "&in_reply_to_status_id=" + encodeURIComponent(inReplyToID);

    this._successCallback = successCallback;
    this._errorCallback   = errorCallback;

    let request = Cc["@mozilla.org/xmlextras/xmlhttprequest;1"].createInstance();

    // FIXME: make a TwitterRequest (or plain Request) object that caches
    // references to the callbacks and the SnowlTwitter instance so we don't
    // have to cache them in the object itself, which could cause problems
    // if we were to persist the instance and send multiple messages through
    // it simultaneously.

    request.QueryInterface(Ci.nsIDOMEventTarget);
    let (t = this) {
      request.addEventListener("load", function(e) { t.onSendLoad(e) }, false);
      request.addEventListener("error", function(e) { t.onSendError(e) }, false);
    }

    request.QueryInterface(Ci.nsIXMLHttpRequest);
    request.open("POST", "https://twitter.com/statuses/update.json", true);
    // If the login manager has saved credentials for this account, provide them
    // to the server.  Otherwise, no worries, Necko will automatically call our
    // notification callback, which will prompt the user to enter their credentials.
    if (this._savedLogin) {
      let credentials = btoa(this.username + ":" + this._savedLogin.password);
      request.setRequestHeader("Authorization", "Basic " + credentials);
    }
    request.channel.notificationCallbacks = this;
    request.setRequestHeader("Content-Type", "application/x-www-form-urlencoded");
    request.send(data);
  },

  onSendLoad: function(event) {
    let request = event.target;

    // FIXME: the next three chunks of code are the same for multiple
    // load handlers; find some way to factor them out.

    // If the request failed, let the error handler handle it.
    // XXX Do we need this?  Don't such failures call the error handler directly?
    if (request.status < 200 || request.status > 299) {
      this.onSendError(event);
      return;
    }

    // If the response is empty, assume failure.
    // XXX What's the right way to handle this?
    if (request.responseText.length == 0) {
      this.onSendError(event);
      return;
    }

    this._log.info("onSendLoad: " + request.responseText);

    // _authInfo only gets set if we prompted the user to authenticate
    // and the user checked the "remember password" box.  Since we're here,
    // it means the request succeeded, so we save the login.
    if (this._authInfo)
      this._saveLogin(this._authInfo);

    this._processSend(request.responseText);

    if (this._successCallback)
      this._successCallback();

    this._resetSend();
  },

  onSendError: function(event) {
    let request = event.target;

    // Sometimes an attempt to retrieve status text throws NS_ERROR_NOT_AVAILABLE
    let statusText = "";
    try { statusText = request.statusText } catch(ex) {}
    
    this._log.error("onSendError: " + request.status + " (" + statusText + ")");

    if (this._errorCallback)
      this._errorCallback();

    this._resetSend();
  },

  _processSend: function(responseText) {
    let JSON = Cc["@mozilla.org/dom/json;1"].createInstance(Ci.nsIJSON);
    let response = JSON.decode(responseText);
    this._addMessage(response, new Date());
  },

  _resetSend: function() {
    this._successCallback = null;
    this._errorCallback = null;
    this._authInfo = null;
  }
};

}
catch (ex) {
  dump("EXCEPTION DURING INIT: " + ex.fileName + ":" + ex.lineNumber + ": " +
      ex + "\n");
}
