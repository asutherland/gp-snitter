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

EXPORTED_SYMBOLS = ['TwitterIndexer'];

const Cc = Components.classes;
const Ci = Components.interfaces;
const Cr = Components.results;
const Cu = Components.utils;

Cu.import("resource://gre/modules/ISO8601DateUtils.jsm");

Cu.import("resource://app/modules/gloda/log4moz.js");

Cu.import("resource://app/modules/gloda/utils.js");
Cu.import("resource://app/modules/gloda/datastore.js");
Cu.import("resource://app/modules/gloda/gloda.js");
Cu.import("resource://app/modules/gloda/collection.js");

Cu.import("resource://app/modules/gloda/indexer.js");
Cu.import("resource://app/modules/gloda/mimemsg.js");
Cu.import("resource://app/modules/gloda/connotent.js");


var TwitterIndexer = {
  _log: null,
  /**
   * All twitter messages come from the same magic folder, and this is it.
   *  Each and every twitter tweet has a unique id, so we namespace them by use
   *  of this folder and the unique id as the message key.
   */
  _twitterFolder: null,
  _twitterSource: null,

  name: "twitter_indexer",
  enable: function() {
    if (this._log == null)
      this._log =  Log4Moz.repository.getLogger("gloda.twitter.indexer");
    
    this._twitterSource = Gloda.defineMessageSource({
      uri: "http://twitter.com/",
      name: "Twitter",
      identityKind: "twitter",
      });
    this._twitterFolder = this._twitterSource.folder;
  },
  
  disable: function() {
  },

  get workers() {
    return [["tweets", this._worker_index_tweets]];
  },
  
  _worker_index_tweets: function(aJob, aCallbackHandle) {
    for (; aJob.offset < aJob.items.length; aJob.offset++) {
      let tweet = aJob.items[aJob.offset];
      yield aCallbackHandle.pushAndGo(this.indexTwitterMessage(tweet,
          aCallbackHandle));
    }
    
    yield GlodaIndexer.kWorkDone;
  },
  
  indexTwitterMessage: function(aTweet, aCallbackHandle) {
    let replyToReference = null;
    let references = [];
    if (aTweet.in_reply_to_status_id) {
      replyToReference = "twitter>" + aTweet.in_reply_to_status_id;
      references.push(replyToReference);
    }
    let headerishMessageId = "twitter>" + aTweet.id
    // also check if this message was already indexed...
    references.push(headerishMessageId);
    
    GlodaDatastore.getMessagesByMessageID(references,
        aCallbackHandle.callback, aCallbackHandle.callbackThis)
    let ancestorLists = yield Gloda.kWorkAsync;
    
    // did we already index this message?  if so, bail 
    if (ancestorLists[0].length && ancestorLists[0][0].folder)
      yield Gloda.kWorkDone;
    
    let conversation = null;
    if (aTweet.in_reply_to_status_id) {
      // we found it!
      if (ancestorLists[1].length) {
        conversation = ancestorLists[1][0].conversation;
      }
      // we "need" to create a conversation and a ghost...
      //  (we could also fetch it or queue it)
      else {
        conversation = GlodaDatastore.createConversation("", null, null);
        let ghost = GlodaDatastore.createMessage(null, null, // ghost
                                                 conversation.id, null,
                                                 replyToReference,
                                                 null, null, null);
        GlodaDatastore.insertMessage(ghost);
      }
    }
    else {
      conversation = GlodaDatastore.createConversation("", null, null);
    }
    
    let curMsg, isRecordNew;
    // it is conceivable that we may exist as a ghost...
    if (ancestorLists[0].length) {
      curMsg = ancestorLists[0][0];
      isRecordNew = false;
      curMsg._folderID = this._twitterFolder.id;
      curMsg._messageKey = aTweet.id;
      curMsg.date = new Date(aTweet.created_at);
    }
    else {
      curMsg = GlodaDatastore.createMessage(this._twitterFolder,
                                            aTweet.id,
                                            conversation.id,
                                            new Date(aTweet.created_at) * 1000,
                                            headerishMessageId);
      curMsg._conversation = conversation;
      isRecordNew = true;
    }

    // --- things that probably should be moved into an attribute provider...
    // (this is safe to do here only because we always indicate that the
    //  message is conceptually new, but we are being bad by doing this!)
    let fromInfo = [aTweet.user.name, aTweet.user.screen_name];
    let toInfo = [];
    // meh, we should probably just regex out the @name things to catch
    //  broadcasts...
    if (aTweet.in_reply_to_screen_name)
      toInfo.push([null, aTweet.in_reply_to_screen_name]);
    
    let [authorIdentities, toIdentities] =
      yield aCallbackHandle.pushAndGo(
        Gloda.getOrCreateIdentities(aCallbackHandle,
                                    this._twitterSource.identityKind,
                                    [fromInfo], toInfo));

    curMsg.from = authorIdentities[0];
    curMsg.to = toIdentities;
    curMsg.cc = [];

    // Create a dummy mime message... we're pretending it had no sub-parts,
    //  just an immediate text part.
    let mimeMsg = new MimeMessage();
    mimeMsg.headers["subject"] = "";
    let bodyPart = new MimeBody("text/plain", false);
    bodyPart.body = aTweet.text;
    mimeMsg.bodyParts.push(bodyPart);
    
    curMsg._isNew = true;
    curMsg._bodyLines = [aTweet.text];
    curMsg._content = new GlodaContent();
    curMsg._subject = "";
    curMsg._attachmentNames = [];

    yield aCallbackHandle.pushAndGo(
        Gloda.grokNounItem(curMsg,
            {mime: mimeMsg,
             bodyLines: curMsg._bodyLines, content: curMsg._content},
            /* conceptually new */ true, isRecordNew,
            aCallbackHandle));
    
    delete curMsg._bodyLines;
    delete curMsg._content;
    delete curMsg._isNew;
    
    yield Gloda.kWorkDone;
  },
  
  initialSweep: function() {
  },
};
GlodaIndexer.registerIndexer(TwitterIndexer);
