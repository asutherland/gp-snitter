/* ***** BEGIN LICENSE BLOCK *****
 *   Version: MPL 1.1/GPL 2.0/LGPL 2.1
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
 * The Original Code is gloda-snowl-twitter.
 *
 * The Initial Developer of the Original Code is
 * Mozilla Messaging, Inc.
 * Portions created by the Initial Developer are Copyright (C) 2008
 * the Initial Developer. All Rights Reserved.
 *
 * Contributor(s):
 *  Andrew Sutherland <asutherland@asutherland.org>
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

Components.utils.import("resource://gpsnitter/modules/acct_twitter.js");
Components.utils.import("resource://gpsnitter/modules/index_twitter.js");

var gpsnitter = {
  onLoad: function() {
    if (!this.initialized) {
      this.initialized = true;
      this.strings = document.getElementById("gpsnitter-strings");
      
      this.evilInit();
    }
  },
  
  /**
   * Consolidated evil actions.
   */
  evilInit: function () {
    // we want our folder node in the tree, but a hack is currently required
    this.oldAllModeFunc = gFolderTreeView._mapGenerators["all"];
    gFolderTreeView._mapGenerators["all"] = this.evilWrappedAllModeFunc;
    gFolderTreeView._rebuild();
  },
  evilWrappedAllModeFunc: function() {
    // (our "this" is not valid)
    let rootNodes = gpsnitter.oldAllModeFunc();
    // put it at the top for now... muahahaha.
    rootNodes.unshift(gpsnitter.folderPaneNode);
    return rootNodes;
  },
  
  folderPaneNode: {
    id: "twitter",
    text: "Twitter",
    level: 0,
    open: false,
    children: [],
    /**
     * @param aProperties An nsIproerties we need to set atoms on.
     */
    getProperties: function gpsnitter_folderPaneNode_getProperties(
        aProperties) {
      let atomSvc = Components.classes["@mozilla.org/atom-service;1"]
                      .getService(Components.interfaces.nsIAtomService);
      function addAtom(aName) {
        aProperties.AppendElement(atomSvc.getAtom(aName));
      }
      addAtom("isServer-true");
      addAtom("serverType-twitter");
      addAtom("biffState-UnknownMail");
      addAtom("noSelect-true");
    },
    command: function gpsnitter_folderPaneNode_doubleClick() {
      dump("DOUBLE CLICK HANDLER!\n");
      let account = new TwitterAccount();
      account.getMessages();
      dump("(done DOUBLE CLICK HANDLER!)\n");
    },
    // urgh, we need a fake _folder
    _folder: {
      glodaFolder: TwitterIndexer._twitterFolder,
      isServer: true,
      isCommandEnabled: function() { return false; },
      prettyName: "Twitter",
      server: {
        performExpand: function() {},
        prettyName: "Twitter",
        type: "imap",
      }
    }
  }
};
window.addEventListener("load", function(e) { gpsnitter.onLoad(e); }, false);
