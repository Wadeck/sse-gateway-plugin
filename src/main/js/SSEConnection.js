/*
 * The MIT License
 *
 * Copyright (c) 2016, CloudBees, Inc.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */

var jsModules = require('@jenkins-cd/js-modules');
var ajax = require('./ajax');
var json = require('./json');

// See https://github.com/tfennelly/jenkins-js-logging - will move to jenskinsci org
var logging = require('@jenkins-cd/logging');
var LOGGER = logging.logger('org.jenkinsci.sse');

// If no clientId is specified, then we generate one with
// an incrementing ID on the end of it. This var holds the
// next Id.
var nextGeneratedClientId = 1;

// A map of client connection by clientId.
var clientConnections = {};

var eventSourceSupported = (window !== undefined && window.EventSource !== undefined);

/* eslint-disable no-use-before-define */
/* eslint-disable quotes */

module.exports = SSEConnection;

function SSEConnection(clientId, configuration) {
    if (typeof clientId === 'string') {
        this.clientId = clientId;
    } else {
        this.clientId = 'sse-client-' + nextGeneratedClientId;
        nextGeneratedClientId++;
    }

    this.configuration = extend({}, SSEConnection.DEFAULT_CONFIGURATION, configuration);

    this.jenkinsUrl = this.configuration.jenkinsUrl;
    this.eventSource = undefined;
    this.eventSourceListenerQueue = [];
    this.connectable = true;
    this.jenkinsSessionInfo = undefined;
    this.subscriptions = [];
    this.channelListeners = {};
    this.configurationBatchId = 0;
    this.configurationQueue = {
        subscribe: [],
        unsubscribe: []
    };
    this.configurationListeners = {};
    this.nextDoConfigureTimeout = undefined;
    this.doPingTimeout = undefined;

    // Initialize the queue config batch tracking
    this._resetConfigQueue();
}

SSEConnection.DEFAULT_CONFIGURATION = {
    batchConfigDelay: 100,
    sendSessionId: false
};

SSEConnection.prototype = {
    connect: function (onConnect) {
        if (this.eventSource) {
            return;
        }
        if (clientConnections[this.clientId]) {
            LOGGER.error('A connection to client having ID ' + this.clientId
                + ' already exists. You must first disconnect if you want to reconnect.');
            return;
        }

        // If the browser supports HTML5 sessionStorage, then lets append a tab specific
        // random ID to the client ID. This allows us to cleanly connect to a backend session,
        // but to do it on a per tab basis i.e. reloading from the same tab reconnects that tab
        // to the same backend dispatcher but allows each tab to have their own dispatcher,
        // avoiding weirdness when multiple tabs are open to the same "clientId".
        var tabClientId = this.clientId;
        if (window.sessionStorage) {
            var storeKey = 'jenkins-sse-gateway-client-' + this.clientId;
            tabClientId = window.sessionStorage.getItem(storeKey);

            if (!tabClientId) {
                tabClientId = this.clientId + '-' + generateId();
                window.sessionStorage.setItem(storeKey, tabClientId);
            }
        }

        if (this.jenkinsUrl === undefined) {
            try {
                this.jenkinsUrl = jsModules.getRootURL();
            } catch (e) {
                LOGGER.warn("Jenkins SSE client initialization failed. Unable to connect to " +
                    "Jenkins because we are unable to determine the Jenkins Root URL. SSE events " +
                    "will not be received. Probable cause: no 'data-rooturl' on the page <head> " +
                    "element e.g. running in a test, or running headless without specifying a " +
                    "Jenkins URL.");
            }
        }
        if (this.jenkinsUrl !== undefined) {
            this.jenkinsUrl = normalizeUrl(this.jenkinsUrl);
        }

        this.pingUrl = this.jenkinsUrl + '/sse-gateway/ping';

        // Used to keep track of connection errors.
        var errorTracking = {
            errors: [],
            reset: function () {
                if (errorTracking.waitForHealingTimeout) {
                    clearTimeout(errorTracking.waitForHealingTimeout);
                    delete errorTracking.waitForHealingTimeout;
                }
                if (errorTracking.pingbackTimeout) {
                    clearTimeout(errorTracking.pingbackTimeout);
                    delete errorTracking.pingbackTimeout;
                }
                errorTracking.errors = [];
            }
        };

        if (!eventSourceSupported) {
            LOGGER.warn("This browser does not support EventSource. Where's the polyfill?");
        } else if (this.jenkinsUrl !== undefined) {
            var connectUrl = this.jenkinsUrl + '/sse-gateway/connect?clientId='
                + encodeURIComponent(tabClientId);

            var sseConnection = this;
            ajax.get(connectUrl, function (response) {
                var listenUrl = sseConnection.jenkinsUrl + '/sse-gateway/listen/'
                    + encodeURIComponent(tabClientId);

                if (sseConnection.configuration.sendSessionId) {
                    // Sending the jsessionid helps headless clients to maintain
                    // the session with the backend.
                    var jsessionid = response.data.jsessionid;
                    listenUrl += ';jsessionid=' + jsessionid;
                }

                var EventSource = window.EventSource;
                var source = new EventSource(listenUrl);

                source.addEventListener('open', function (e) {
                    LOGGER.debug('SSE channel "open" event.', e);
                    errorTracking.reset();
                    if (e.data) {
                        sseConnection.jenkinsSessionInfo = JSON.parse(e.data);
                        if (onConnect) {
                            onConnect(sseConnection.jenkinsSessionInfo);
                        }
                    }
                }, false);
                source.addEventListener('error', function (e) {
                    LOGGER.debug('SSE channel "error" event.', e);
                    if (errorTracking.errors.length === 0) {
                        // First give the connection a chance to heal itself.
                        errorTracking.waitForHealingTimeout = setTimeout(function () {
                            if (errorTracking.errors.length !== 0) {
                                // The connection is still not ok. Lets fire a ping request.
                                // If the connection becomes ok, we should get a pingback
                                // ack and the timeouts etc should get cleared etc.
                                // See 'pingback' below
                                errorTracking.pingbackTimeout = setTimeout(function () {
                                    delete errorTracking.pingbackTimeout;
                                    if (typeof sseConnection._onerror === 'function'
                                        && errorTracking.errors.length > 0) {
                                        var errorToSend = errorTracking.errors[0];
                                        errorTracking.reset();
                                        try {
                                            sseConnection._onerror(errorToSend);
                                        } catch (error) {
                                            LOGGER.error('SSEConnection "onError" event handler ' +
                                                'threw unexpected error.', error);
                                        }
                                    } else {
                                        errorTracking.reset();
                                    }
                                }, 3000); // TODO: magic num ... what's realistic ?
                                ajax.get(sseConnection.pingUrl + '?dispatcherId=' +
                                    encodeURIComponent(
                                        sseConnection.jenkinsSessionInfo.dispatcherId));
                            }
                        }, 4000); // TODO: magic num ... what's realistic ?
                    }
                    errorTracking.errors.push(e);
                }, false);
                source.addEventListener('pingback', function (e) {
                    LOGGER.debug('SSE channel "pingback" event received.', e);
                    errorTracking.reset();
                }, false);
                source.addEventListener('configure', function (e) {
                    LOGGER.debug('SSE channel "configure" ACK event (see batchId on event).', e);
                    if (e.data) {
                        var configureInfo = JSON.parse(e.data);
                        sseConnection._notifyConfigQueueListeners(configureInfo.batchId);
                    }
                }, false);
                source.addEventListener('reload', function (e) {
                    LOGGER.debug('SSE channel "reload" event received. Reloading page now.', e);
                    window.location.reload(true);
                }, false);

                // Add any listeners that have been requested to be added.
                for (var i = 0; i < sseConnection.eventSourceListenerQueue.length; i++) {
                    var config = sseConnection.eventSourceListenerQueue[i];
                    source.addEventListener(config.channelName, config.listener, false);
                }

                sseConnection.eventSource = source;
                if (sseConnection.connectable === false) {
                    sseConnection.disconnect();
                }
            }, function (httpObject) {
                LOGGER.error('SSEConnection failure (' + httpObject.status
                    + '): ' + httpObject.responseText, httpObject);
                sseConnection.connectable = false;
                sseConnection._clearDoConfigure();
            });
        }

        clientConnections[this.clientId] = this;
    },
    isConnected: function () {
        // We are connected if we have an EventSource object.
        return (this.eventSource !== undefined);
    },
    onError: function (handler) {
        this._onerror = handler;
    },
    waitConnectionOk: function (handler) {
        if (!this.eventSource) {
            throw new Error('Not connected.');
        }
        if (typeof handler !== 'function') {
            throw new Error('No waitServerRunning callback function provided.');
        }

        var sseConnection = this;
        var connection = this;
        var connectErrorCount = 0;

        function doPingWait() {
            ajax.isAlive(connection.pingUrl, function (status) {
                // Ok to schedule another ping.
                sseConnection.doPingTimeout = undefined;

                var connectError = false;
                // - status 0 "typically" means timed out. Anything less than 100
                //   is meaningless anyway, so lets just go with that.
                // - status 500+ errors mean that the server (or intermediary) are
                //   unable to handle the request, which from a users point of view
                //   is equivalent to not being able to connect to the server.
                if (status < 100 || status >= 500) {
                    connectError = true;
                    connectErrorCount++;

                    // Try again in few seconds
                    LOGGER.debug('Server connection error %s (%s).', status, connection.jenkinsUrl);
                    sseConnection.doPingTimeout = setTimeout(doPingWait, 3000);
                } else {
                    // Ping worked ... we connected.
                    LOGGER.debug('Server connection ok.');
                }
                handler({
                    statusCode: status,
                    connectError: connectError,
                    connectErrorCount: connectErrorCount
                });
            });
        }
        if (!sseConnection.doPingTimeout) {
            doPingWait();
        }
    },
    disconnect: function () {
        try {
            if (this.eventSource) {
                try {
                    if (typeof this.eventSource.removeEventListener === 'function') {
                        for (var channelName in this.channelListeners) {
                            if (this.channelListeners.hasOwnProperty(channelName)) {
                                try {
                                    this.eventSource.removeEventListener(channelName,
                                        this.channelListeners[channelName]);
                                } catch (e) {
                                    LOGGER.error('Unexpected error removing listners', e);
                                }
                            }
                        }
                    }
                } finally {
                    try {
                        this.eventSource.close();
                    } finally {
                        this.eventSource = undefined;
                        this.channelListeners = {};
                        delete clientConnections[this.clientId];
                    }
                }
            }
        } finally {
            this.connectable = false;
            this._clearDoConfigure();
        }
    },
    subscribe: function () {
        this._clearDoConfigure();

        if (!this.connectable) {
            return undefined;
        }

        var channelName;
        var filter;
        var callback;
        var onSubscribed;

        // sort out the args.
        if (arguments.length === 1 && typeof arguments[0] === 'object') {
            var configObj = arguments[0];
            channelName = configObj.channelName;
            callback = configObj.onEvent;
            filter = configObj.filter;
            onSubscribed = configObj.onSubscribed;
        } else {
            for (var i = 0; i < arguments.length; i++) {
                var arg = arguments[i];
                if (typeof arg === 'string') {
                    channelName = arg;
                } else if (typeof arg === 'function') {
                    callback = arg;
                } else if (typeof arg === 'object') {
                    filter = arg;
                }
            }
        }

        if (channelName === undefined) {
            throw new Error('No channelName arg provided.');
        }
        if (callback === undefined) {
            throw new Error('No callback arg provided.');
        }

        var config;

        if (filter) {
            // Clone the filter as the config.
            config = JSON.parse(json.stringify(filter));
        } else {
            config = {};
        }

        config.jenkins_channel = channelName;

        this.subscriptions.push({
            config: config,
            callback: callback
        });
        if (!this.configurationQueue.subscribe) {
            this.configurationQueue.subscribe = [];
        }
        this.configurationQueue.subscribe.push(config);

        if (!this.channelListeners[channelName]) {
            this._addChannelListener(channelName);
        }

        this._scheduleDoConfigure();

        if (onSubscribed) {
            this._addConfigQueueListener(onSubscribed);
        }

        return callback;
    },
    unsubscribe: function (callback, onUnsubscribed) {
        this._clearDoConfigure();

        // callback is the only mandatory param
        if (callback === undefined) {
            throw new Error('No callback provided');
        }

        var newSubscriptionList = [];
        for (var i = 0; i < this.subscriptions.length; i++) {
            var subscription = this.subscriptions[i];
            if (subscription.callback === callback) {
                if (!this.configurationQueue.unsubscribe) {
                    this.configurationQueue.unsubscribe = [];
                }
                this.configurationQueue.unsubscribe.push(subscription.config);
            } else {
                newSubscriptionList.push(subscription);
            }
        }
        this.subscriptions = newSubscriptionList;

        this._scheduleDoConfigure();

        if (onUnsubscribed) {
            this._addConfigQueueListener(onUnsubscribed);
        }
    },
    _resetConfigQueue: function (skipPendingCheck) {
        if (!skipPendingCheck && this._hasPendingConfigs()) {
            throw new Error('Invalid call to reset the SSE config queue ' +
                'while there are pending configs.', this.configurationQueue);
        }
        this.configurationBatchId++;
        this.configurationQueue = {
            subscribe: [],
            unsubscribe: []
        };
        this.configurationListeners[this.configurationBatchId.toString()] = [];
    },
    _addConfigQueueListener: function (listener) {
        // Config queue listeners are always added against the current batchId.
        // When that config batch is sent, these listeners will be notified on
        // receipt of the "configure" SSE event, which will contain that batchId.
        // See the notifyConfigQueueListeners function below.
        var batchListeners =
            this.configurationListeners[this.configurationBatchId.toString()];

        if (batchListeners) {
            batchListeners.push(listener);
        } else {
            LOGGER.error(new Error('Unexpected call to addConfigQueueListener for an ' +
                'obsolete/unknown batchId ' + this.configurationBatchId
                + '. This should never happen!!'));
        }
    },
    _notifyConfigQueueListeners: function (batchId) {
        var batchListeners = this.configurationListeners[batchId.toString()];
        if (batchListeners) {
            delete this.configurationListeners[batchId.toString()];
            for (var i = 0; i < batchListeners.length; i++) {
                try {
                    batchListeners[i]();
                } catch (e) {
                    LOGGER.error('Unexpected error calling config queue listener.', e);
                }
            }
        }
    },
    _clearDoConfigure: function () {
        if (this.nextDoConfigureTimeout) {
            clearTimeout(this.nextDoConfigureTimeout);
        }
        this.nextDoConfigureTimeout = undefined;
    },
    _scheduleDoConfigure: function (delay) {
        this._clearDoConfigure();
        var timeoutDelay = delay;
        if (timeoutDelay === undefined) {
            timeoutDelay = this.configuration.batchConfigDelay;
        }
        var self = this;
        this.nextDoConfigureTimeout = setTimeout(function () {
            self._doConfigure();
        }, timeoutDelay);
    },
    _addChannelListener: function (channelName) {
        var sseConnection = this;

        var listener = function (event) {
            if (LOGGER.isLogEnabled()) {
                var channelEvent = JSON.parse(event.data);
                LOGGER.log('Received event "' + channelEvent.jenkins_channel
                    + '/' + channelEvent.jenkins_event + ':', channelEvent);
            }

            // Iterate through all of the subscriptions, looking for
            // subscriptions on the channel that match the filter/config.
            var processCount = 0;
            for (var i = 0; i < sseConnection.subscriptions.length; i++) {
                var subscription = sseConnection.subscriptions[i];

                if (subscription.config.jenkins_channel === channelName) {
                    // Parse the data every time, in case the
                    // callback modifies it.
                    var parsedData = JSON.parse(event.data);
                    // Make sure the data matches the config, which is the filter
                    // plus the channel name (and the message should have the
                    // channel name in it).
                    if (containsAll(parsedData, subscription.config)) {
                        try {
                            processCount++;
                            subscription.callback(parsedData);
                        } catch (e) {
                            LOGGER.debug(e);
                        }
                    }
                }
            }
            if (processCount === 0 && LOGGER.isWarnEnabled()) {
                LOGGER.warn('Event not processed by any active listeners ('
                    + sseConnection.subscriptions.length + ' of). Check event ' +
                    'payload against subscription ' +
                    'filters - see earlier "notification configuration" request(s).');
            }
        };

        this.channelListeners[channelName] = listener;
        if (this.eventSource) {
            this.eventSource.addEventListener(channelName, listener, false);
        } else {
            this.eventSourceListenerQueue.push({
                channelName: channelName,
                listener: listener
            });
        }
    },
    _doConfigure: function () {
        this.nextDoConfigureTimeout = undefined;

        var sessionInfo = this.jenkinsSessionInfo;

        if (!sessionInfo && eventSourceSupported) {
            // Can't do it yet. Need to wait for the SSE Gateway to
            // open the SSE channel + send the jenkins session info.
            this._scheduleDoConfigure(100);
        } else if (this._hasPendingConfigs()) {
            var configureUrl = this.jenkinsUrl + '/sse-gateway/configure?batchId='
                + this.configurationBatchId;

            if (LOGGER.isDebugEnabled()) {
                LOGGER.debug('Sending notification configuration request for configuration batch '
                    + this.configurationBatchId + '.', this.configurationQueue);
            }

            this.configurationQueue.dispatcherId = sessionInfo.dispatcherId;
            // clone the config, just in case of bad change later.
            var configurationQueue = JSON.parse(json.stringify(this.configurationQueue));
            var sseConnection = this;

            ajax.post(configurationQueue, configureUrl, sessionInfo, function (data, http) {
                LOGGER.error('Error configuring SSE connection.', data, http);
                if (sseConnection.configuration.onConfigError) {
                    sseConnection.configuration.onConfigError(data, http);
                }
            });

            this._resetConfigQueue(true);
        }
    },
    _hasPendingConfigs: function () {
        return (this.configurationQueue.subscribe.length > 0
                || this.configurationQueue.unsubscribe.length > 0);
    }
};

/* eslint-disable no-param-reassign */

function containsAll(object, filter) {
    for (var property in filter) {
        if (filter.hasOwnProperty(property)) {
            var objVal = object[property];
            var filterVal = filter[property];
            if (objVal === undefined) {
                return false;
            }
            // String comparison i.e. ignore type
            if (objVal.toString() !== filterVal.toString()) {
                return false;
            }
        }
    }
    return true;
}

function normalizeUrl(url) {
    if (!url) {
        return '';
    }
    // remove trailing slashes
    var newUrl = url;
    while (newUrl.charAt(newUrl.length - 1) === '/') {
        newUrl = newUrl.substring(0, newUrl.length - 1);
    }
    return newUrl;
}

/**
 * Generate a random "enough" string from the current time in
 * millis + a random generated number string.
 * @returns {string}
 */
function generateId() {
    return (new Date().getTime()) + '-' + (Math.random() + 1).toString(36).substring(7);
}

/**
 * Simple Object extend utility function.
 * <p/>
 * Extends the 1st argument object by mapping the following arg objects onto it.
 * @returns {object} The first argument (the target).
 */
function extend() {
    if (arguments.length < 2) {
        throw new Error('There must be at least 2 arguments.');
    }

    var target = arguments[0];
    for (var i = 1; i < arguments.length; i++) {
        var source = arguments[i];
        for (var prop in source) {
            if (source.hasOwnProperty(prop)) {
                target[prop] = source[prop];
            }
        }
    }
    return target;
}
