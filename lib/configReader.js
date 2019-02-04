/**
 * Cryptonote Node.JS Pool
 * https://github.com/dvandal/cryptonote-nodejs-pool
 *
 * Configuration Reader
 **/

// Load required modules
var fs = require('fs');

// Set pool software version
global.version = "v1.3.5";

/**
 * Load pool configuration
 **/
 
// Get configuration file path
var configFile = (function(){
    for (var i = 0; i < process.argv.length; i++){
        if (process.argv[i].indexOf('-config=') === 0)
            return process.argv[i].split('=')[1];
    }
    return 'config.json';
})();

// Read configuration file data
try {
    global.config = JSON.parse(fs.readFileSync(configFile));
}
catch(e){
    console.error('Failed to read config file ' + configFile + '\n\n' + e);
    return;
}

/**
 * Developper donation addresses -- thanks for supporting my works!
 **/
 
var donationAddresses = {
    DCY: 'YwzQtGtX3Spdmaoo1XZ9u9WXhxp5d3kACaw3B3VuAcdkEynqGrTzTV3XFeMtw8iiJN2kWYcBqPjuL5Fg97ZjjRk41V1dTM7VS+4897e6e34989bf2e7f7430483b3d3ad5fd4281baada2af5f17fff25e7ea09fb0',
    ETN: 'etnkK41HsyNUvtnBX7hsrn3z9VZquSfUGb5Y1uTxQav8GQn9KNjpucgYa5C9wSb5TndUXBfZwajbmPLTjdEr1WG6Ag1KbzcNi1+b3a46b5a58d047bf30e201ff10af766b95a17c3d8897b590b35ae69213586d07'
};

global.donations = {};

var percent = config.blockUnlocker.devDonation;
var wallet = donationAddresses[config.symbol];
if (percent && wallet) {
    global.donations[wallet] = percent;
}
