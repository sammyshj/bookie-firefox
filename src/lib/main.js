var data = require("sdk/self").data,
    prefs = require('sdk/simple-prefs'),
    tabs = require("sdk/tabs"),
    widgets = require("sdk/widget"),
    BookieApi = require('./api').BookieApi,
    timer = require('sdk/timers'),
    api = BookieApi(prefs.prefs),
    { Hotkey } = require("sdk/hotkeys");

// Util to hash a url into the hash_id used in Bookie.
var hash_url = require("./hash").hash_url;

// Storage to keep track of the bookmarks we've bookmarked before.
var storage = require('./storage').Storage();

// Setup the preferences and watch for changes to set values.
// Hold a reference to the preferences for the ability to bind to it's events?
var preferences = require('./preferences');
var preferenceData = preferences.init(prefs, api, storage);

// @ToDo
// The panel needs to bind to the onPrefChange event. However, only if it's
// successful. It should publish a new event that the panel can listen to.
var panel = require('./panel');
var bookie_panel = panel.init(preferenceData, api, storage);

// The icon in the addon toolbar.
// @ToDo
// Move the widget to it's own module? It looks rather self contained though.
// @ToDo
// The widget needs to listen to the success event to get the
// widget.port.emit() value from the contained save function.
var widget = widgets.Widget({
  id: "bookie-widget",
  label: "Create Bookie Bookmark",
  contentURL: data.url('widget_html.html'),
  contentScriptFile: data.url('widget_script.js'),
  panel: bookie_panel
});

// Make sure the panel notifies the widget that things have happened.
bookie_panel.bindWidget(widget);

// Whenever the tab changes, check if we should be showing the bookmark'd icon
// or the normal icon to the user.
tabs.on('activate', function(tab) {
    var hash_id = hash_url(tab.url);

    if (storage.get(hash_id)) {
        widget.port.emit('bmark_exists');
    } else {
        widget.port.emit('icon_reset');
    }
});
tabs.on('ready', function(tab) {
    var hash_id = hash_url(tab.url);

    if (storage.get(hash_id)) {
        widget.port.emit('bmark_exists');
    } else {
        widget.port.emit('icon_reset');
    }
});


var showBmarkPanel = Hotkey({
    combo: "accel-alt-d",
    onPress: function() {
        bookie_panel.show({
            position: {
                bottom: 10,
                right: 10
            }
        });
    }
});

exports.main = function(options, callbacks) {

    // Allow up to a minute for the extension to download the hashes and
    // update them in the local storage. Otherwise, the intervals after
    // which the hashes are updated is nearly doubled.
    var minute = 60 * 1000,
        interval = (86400 * 1000) + minute,
        api = BookieApi(prefs.prefs),
        that = {
            storage: storage
        };

    api.checkNew(
        storage.get('lastSync'),
        storage.get('savedPrefs'),
        interval - minute,
        that);

    // The reason why preferences, lastSync, savedPrefs
    // are not cached is that they can change over a period of time.
    // In the worst case, the hash list will remain out of sync for
    // a period of 47 hours.
    var handle = timer.setInterval(function() {
        var api = BookieApi(prefs.prefs);
        api.checkNew(
            storage.get('lastSync'),
            storage.get('savedPrefs'),
            interval - minute,
            that);
    }, interval);

    // When the extension is first installed, take the user to the options
    // page like in the chrome extensions and have him fill the settings.
    // Check for the savedPrefs flag every single time the extensions starts
    // up. Set the key only when the user enters a valid key for the first
    // time.
    if (options.loadReason === 'install' || options.loadReason === 'startup' ||
            options.loadReason === 'enable') {
        if (storage.get("savedPrefs")) {
            return;
        }

        var worker;
        var attach = function(tab) {
            worker = tab.attach({
                contentScriptFile: data.url("options.js")
            });
            bindWorker();
        };

        var bindWorker = function() {

            worker.port.on("getPreferences", function(){
                worker.port.emit("prefData", prefs.prefs);
            });

            worker.port.on("savePreferences", function(prefData) {

                var api = BookieApi(prefData),
                    that = {
                        storage: storage
                    };

                api.ping({
                    success: function(response) {
                        if (response.json.success) {
                            var that = {
                                storage: storage
                            };

                            // Update the preferences using the preference service.
                            var newPrefs = prefs.prefs;

                            newPrefs.api_url = prefData.api_url;
                            newPrefs.api_username = prefData.api_username;
                            newPrefs.api_key = prefData.api_key;
                            newPrefs.cache_content = prefData.cache_content;

                            prefs.prefs = newPrefs;
                            storage.save("savedPrefs", true);

                            // Force update.
                            api.checkNew(0, true, 0, that);
                            worker.port.emit("pingSucceeded");
                        }
                    },
                    failure: function(response) {
                        // Emit a message so that options.js can modify the HTML and
                        // inform the user to verify his credentials.
                        worker.port.emit("pingFailed", response.json);
                    }
                }, this);
            });

            worker.port.on("syncBookmarks", function() {
                var api = BookieApi(prefs.prefs);
                api.sync({
                    success: function(resp) {
                        resp.json.hash_list.forEach(function(key) {
                            storage.save(key, true);
                            worker.port.emit("syncSuccess");
                        });

                        // Update the last sync flag here.
                        storage.save('lastSync',(new Date()).getTime());
                    },
                    failure: function(resp) {
                        console.log('sync fail');
                        console.log(resp.json);
                        worker.port.emit("syncFailure", resp.json.message);
                    }
                }, this);
            });
        };

        // To successfully retrieve the DOM and not run into errors,
        // wait for the DOM content to finish loading.
        tabs.open({
            url: data.url('options.html'),
            onLoad: attach
        });
    }
};

