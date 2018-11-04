var async = require('async');

var apiInterfaces = require('./apiInterfaces.js')(config.daemon, config.wallet, config.api);

var logSystem = 'unlocker';
require('./exceptionWriter.js')(logSystem);

log('info', logSystem, 'Started');

function runInterval(){
    async.waterfall([

        //Get all block candidates in redis
        function(callback){
            redisClient.zrange(config.coin + ':blocks:candidates', 0, -1, 'WITHSCORES', function(error, results){
                if (error){
                    log('error', logSystem, 'Error trying to get pending blocks from redis %j', [error]);
                    callback(true);
                    return;
                }
                if (results.length === 0){
                    log('info', logSystem, 'No blocks candidates in redis');
                    callback(true);
                    return;
                }

                var blocks = [];

                for (var i = 0; i < results.length; i += 2){
                    var parts = results[i].split(':');
                    blocks.push({
                        serialized: results[i],
                        height: parseInt(results[i + 1]),
                        hash: parts[0],
                        time: parts[1],
                        difficulty: parts[2],
                        shares: parts[3]
                    });
                }

                callback(null, blocks);
            });
        },

        //Check if blocks are orphaned
        function(blocks, callback){
            async.filter(blocks, function(block, mapCback){
                apiInterfaces.rpcDaemon('getblockheaderbyhash', {hash: block.hash}, function(error, result){
                    if (error){
                        log('error', logSystem, 'Error with getblockheaderbyhash RPC request for block %s - %j', [block.serialized, error]);
                        block.unlocked = false;
                        mapCback();
                        return;
                    }
                    if (!result.block_header){
                        log('error', logSystem, 'Error with getblockheaderbyhash, no details returned for %s - %j', [block.serialized, result]);
                        block.unlocked = false;
                        mapCback();
                        return;
                    }
                    var blockHeader = result.block_header;
                    //block.orphaned = blockHeader.topoheight > 1 ? 0 : 1;
                    block.orphaned = blockHeader.orphan_status;
                    block.unlocked = blockHeader.depth >= config.blockUnlocker.depth;
                    block.reward = blockHeader.reward;
                    mapCback(block.unlocked);
                });
            }, function(unlockedBlocks){

                if (unlockedBlocks.length === 0){
                    log('info', logSystem, 'No pending blocks are unlocked yet (%d pending)', [blocks.length]);
                    callback(true);
                    return;
                }

                callback(null, unlockedBlocks)
            })
        },

        //Get worker shares for each unlocked block
        function(blocks, callback){
 
            var redisCommands = blocks.map(function(block){
                return ['hgetall', config.coin + ':shares_actual:round' + block.height];
            });


            redisClient.multi(redisCommands).exec(function(error, replies){
                if (error){
                    log('error', logSystem, 'Error with getting round shares from redis %j', [error]);
                    callback(true);
                    return;
                }
                for (var i = 0; i < replies.length; i++){
                    var workerShares = replies[i];
                    blocks[i].workerShares = workerShares;
                }
                callback(null, blocks);
            });
        },

        //Handle orphaned blocks
        function(blocks, callback){
            var orphanCommands = [];

            blocks.forEach(function(block){
                if (!block.orphaned) return;
		
		orphanCommands.push(['del', config.coin + ':scores:round' + block.height]);
                orphanCommands.push(['del', config.coin + ':shares_actual:round' + block.height]);

                orphanCommands.push(['zrem', config.coin + ':blocks:candidates', block.serialized]);
                orphanCommands.push(['zadd', config.coin + ':blocks:matured', block.height, [
                    block.hash,
                    block.time,
                    block.difficulty,
                    block.shares,
                    block.orphaned
                ].join(':')]);

                if (block.workerShares) {
                    var workerShares = block.workerShares;
                    Object.keys(workerShares).forEach(function (worker) {
                        orphanCommands.push(['hincrby', config.coin + ':shares_actual:roundCurrent', worker, workerShares[worker]]);
                    });
                }
            });

            if (orphanCommands.length > 0){
                redisClient.multi(orphanCommands).exec(function(error, replies){
                    if (error){
                        log('error', logSystem, 'Error with cleaning up data in redis for orphan block(s) %j', [error]);
                        callback(true);
                        return;
                    }
                    callback(null, blocks);
                });
            }
            else{
                callback(null, blocks);
            }
        },

        //Handle unlocked blocks
        function(blocks, callback){
            var unlockedBlocksCommands = [];
            var payments = {};
            var totalBlocksUnlocked = 0;
            blocks.forEach(function(block){
                if (block.orphaned) return;
                totalBlocksUnlocked++;

	        unlockedBlocksCommands.push(['del', config.coin + ':scores:round' + block.height]);
                unlockedBlocksCommands.push(['del', config.coin + ':shares_actual:round' + block.height]);
                unlockedBlocksCommands.push(['zrem', config.coin + ':blocks:candidates', block.serialized]);
                unlockedBlocksCommands.push(['zadd', config.coin + ':blocks:matured', block.height, [
                    block.hash,
                    block.time,
                    block.difficulty,
                    block.shares,
                    block.orphaned,
                    block.reward
                ].join(':')]);

		unlockedBlocksCommands.push(['zadd', config.coin + ':blocks:reward', block.height, block.reward/config.coinUnits]);
		unlockedBlocksCommands.push(['expire', config.coin + ':blocks:reward', 86400*7]);
		redisClient.zrevrange(config.coin + ':blocks:reward', -100, -1, function(error, members){
			var rewardheight = 0;
			var avgreward = 0;
			for (var i = 0; i < members.length; i++){
			   rewardheight += parseFloat(members[i]);
			//log('info', logSystem, 'Gia tri trong rewardheight la %d',[rewardheight]);
			};
			avgreward = rewardheight/members.length;
			log('info', logSystem, 'Trung binh reward la %d rewardheight la %d', [avgreward,rewardheight]);
			redisClient.hset(config.coin + ':blocks:averaged', 'AvgReward', avgreward);
		});

                var feePercent = config.blockUnlocker.poolFee / 100;

                if (Object.keys(donations).length) {
                    for(var wallet in donations) {
                        var percent = donations[wallet] / 100;
                        feePercent += percent;
                        payments[wallet] = Math.round(block.reward * percent);
                        log('info', logSystem, 'Block %d donation to %s as %d percent of reward: %d', [block.height, wallet, percent, payments[wallet]]);
                    }
                }

                var reward = Math.round(block.reward - (block.reward * feePercent));

                log('info', logSystem, 'Unlocked %d block with reward %d and donation fee %d. Miners reward: %d', [block.height, block.reward, feePercent, reward]);

                if (block.workerShares) {
		var mShares =  Object.keys( block.workerShares).reduce( function( sum, key ){
                	return sum + parseFloat( block.workerShares[key] );
              	 }, 0 );
			
                    var oShares = parseFloat(block.shares);
			//var totalShares = mShares > oShares?mShares :oShares;
			var totalShares = mShares;
			log('info', logSystem, 'total: %d - %d - %d', [mShares ,oShares, totalShares ]);
                    Object.keys(block.workerShares).forEach(function (worker) {
                        var percent = block.workerShares[worker] / totalShares;
                        var workerReward = Math.round(reward * percent);
                        payments[worker] = (payments[worker] || 0) + workerReward;
                        log('info', logSystem, 'Block %d payment to %s for %d%%  total_reward: %d current_reward: %d', [block.height, worker, percent*100, payments[worker],workerReward]);
                    });

   

                }
            });

            for (var worker in payments) {
                var amount = parseInt(payments[worker]);
                if (amount <= 0){
                    delete payments[worker];
                    continue;
                }
		//log('info', logSystem, 'Update balance worker: %s payment: %d',[worker,amount]);
                unlockedBlocksCommands.push(['hincrby', config.coin + ':workers:' + worker, 'balance', amount]);
            }

            if (unlockedBlocksCommands.length === 0){
                log('info', logSystem, 'No unlocked blocks yet (%d pending)', [blocks.length]);
                callback(true);
                return;
            }

            redisClient.multi(unlockedBlocksCommands).exec(function(error, replies){
                if (error){
                    log('error', logSystem, 'Error with unlocking blocks %j', [error]);
                    callback(true);
                    return;
                }
                log('info', logSystem, 'Unlocked %d blocks and update balances for %d workers', [totalBlocksUnlocked, Object.keys(payments).length]);
                callback(null);
            });
        }
    ], function(error, result){
        setTimeout(runInterval, config.blockUnlocker.interval * 1000);
    })
}

runInterval();