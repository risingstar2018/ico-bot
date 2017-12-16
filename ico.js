/*jslint node: true */
'use strict';
const moment = require('moment');
const constants = require('byteballcore/constants.js');
const conf = require('byteballcore/conf');
const db = require('byteballcore/db');
const eventBus = require('byteballcore/event_bus');
const texts = require('./texts');
const validationUtils = require('byteballcore/validation_utils');
const notifications = require('./modules/notifications');
const byteball_ins = require('./modules/byteball_ins');
const ethereum_ins = require('./modules/ethereum_ins');
const conversion = require('./modules/conversion.js');
const Web3 = require('web3')
const BigNumber = require('bignumber.js');

let web3;

if (!conf.issued_asset)
	throw Error("please isssue the asset first by running scripts/issue_tokens.js");

if (conf.ethEnabled) {
	web3 = new Web3(new Web3.providers.WebsocketProvider(conf.ethWSProvider));
}

conversion.enableRateUpdates();

function sendTokensToUser(objPayment) {
	const mutex = require('byteballcore/mutex');
	mutex.lock(['tx-' + objPayment.transaction_id], unlock => {
		db.query("SELECT paid_out FROM transactions WHERE transaction_id=?", [objPayment.transaction_id], rows => {
			if (rows.length === 0)
				throw Error('tx ' + objPayment.transaction_id + ' not found');
			if (rows[0].paid_out)
				return unlock();
			const headlessWallet = require('headless-byteball');
			headlessWallet.issueChangeAddressAndSendPayment(
				conf.issued_asset, objPayment.tokens, objPayment.byteball_address, objPayment.device_address,
				(err, unit) => {
					if (err) {
						notifications.notifyAdmin('sendTokensToUser ICO failed', err + "\n\n" + JSON.stringify(objPayment, null, '\t'));
						return unlock();
					}
					db.query(
						"UPDATE transactions SET paid_out = 1, paid_date = " + db.getNow() + ", payout_unit=? WHERE transaction_id = ? AND paid_out = 0",
						[unit, objPayment.transaction_id],
						() => {
							unlock();
						}
					);
				}
			);
		});
	});
}


eventBus.on('paired', from_address => {
	let device = require('byteballcore/device.js');
	var text = texts.greeting();
	checkUserAdress(from_address, 'BYTEBALL', bByteballAddressKnown => {
		if (bByteballAddressKnown)
			text += "\n\n" + texts.howmany();
		else
			text += "\n\n" + texts.insertMyAddress();
		device.sendMessageToDevice(from_address, 'text', text);
	});
});

eventBus.once('headless_and_rates_ready', () => {
	const headlessWallet = require('headless-byteball');
	headlessWallet.setupChatEventHandlers();
	eventBus.on('text', (from_address, text) => {
		let device = require('byteballcore/device');
		let ucText = text.toUpperCase().trim();

		if (moment() < moment(conf.startDate, 'DD.MM.YYYY hh:mm'))
			return device.sendMessageToDevice(from_address, 'text', 'The ICO has not begun yet.');
		if (moment() > moment(conf.endDate, 'DD.MM.YYYY hh:mm'))
			return device.sendMessageToDevice(from_address, 'text', 'The ICO is already over.');

		checkUserAdress(from_address, 'BYTEBALL', bByteballAddressKnown => {
			if (!bByteballAddressKnown && !validationUtils.isValidAddress(ucText)) {
				return device.sendMessageToDevice(from_address, 'text', texts.insertMyAddress());
			} else if (validationUtils.isValidAddress(ucText)) {
				db.query('INSERT OR REPLACE INTO user_addresses (device_address, platform, address) VALUES(?,?,?)', [from_address, 'BYTEBALL', ucText], () => {
					device.sendMessageToDevice(from_address, 'text', 'Saved your Byteball address.\n\n' + texts.howmany());
				});
				return;
			} else if (Web3.utils.isAddress(ucText)) {
				db.query('INSERT OR REPLACE INTO user_addresses (device_address, platform, address) VALUES(?,?,?)', [from_address, 'ETHEREUM', ucText], () => {
					device.sendMessageToDevice(from_address, 'text', 'Saved your Ethereum address.\n\n' + texts.howmany());
				});
				return;
			} else if (/^[0-9.]+[\sA-Z]+$/.test(ucText)) {
				let amount = parseFloat(ucText.match(/^([0-9.]+)[\sA-Z]+$/)[1]);
				let currency = ucText.match(/[A-Z]+$/)[0];
				if (amount < 0.000000001)
					return device.sendMessageToDevice(from_address, 'text', 'Min amount 0.000000001');
				let tokens, display_tokens;
				switch (currency) {
					case 'GB':
					case 'GBYTE':
						let bytes = Math.round(amount * 1e9);
						tokens = conversion.convertCurrencyToTokens(amount, 'GBYTE');
						if (tokens === 0)
							return device.sendMessageToDevice(from_address, 'text', 'The amount is too small');
						display_tokens = tokens / conversion.displayTokensMultiplier;
						byteball_ins.readOrAssignReceivingAddress(from_address, receiving_address => {
							device.sendMessageToDevice(from_address, 'text', 'You buy: ' + display_tokens + ' ' + conf.tokenName +
								'\n[' + ucText + '](byteball:' + receiving_address + '?amount=' + bytes + ')');
						});
						break;
					case 'ETH':
					case 'ETHER':
						tokens = conversion.convertCurrencyToTokens(amount, 'ETH')
						if (tokens === 0)
							return device.sendMessageToDevice(from_address, 'text', 'The amount is too small');
						display_tokens = tokens / conversion.displayTokensMultiplier;
						ethereum_ins.readOrAssignReceivingAddress(from_address, receiving_address => {
							device.sendMessageToDevice(from_address, 'text', 'You buy: ' + display_tokens + ' ' + conf.tokenName +
								'\n - ' + receiving_address);
						})
						break;
					case 'USDT':
						device.sendMessageToDevice(from_address, 'text', currency + ' not implemented yet');
						break;
					case 'BTC':
					default:
						device.sendMessageToDevice(from_address, 'text', 'Currency is not supported');
						break;
				}
				return;
			}

			var text = texts.greeting();
			if (bByteballAddressKnown)
				text += "\n\n" + texts.howmany();
			else
				text += "\n\n" + texts.insertMyAddress();
			device.sendMessageToDevice(from_address, 'text', text);
		});
	});
});

function checkAndPayNotPaidTransactions() {
	let network = require('byteballcore/network.js');
	if (network.isCatchingUp())
		return;
	db.query(
		"SELECT transactions.* \n\
		FROM transactions \n\
		LEFT JOIN outputs ON byteball_address=outputs.address AND tokens=outputs.amount AND asset=? \n\
		LEFT JOIN unit_authors USING(unit) \n\
		LEFT JOIN my_addresses ON unit_authors.address=my_addresses.address \n\
		WHERE my_addresses.address IS NULL AND paid_out=0",
		[conf.issued_asset],
		rows => {
			rows.forEach(sendTokensToUser);
		}
	);
}


function checkUserAdress(device_address, platform, cb) {
	db.query("SELECT address FROM user_addresses WHERE device_address = ? AND platform = ?", [device_address, platform.toUpperCase()], rows => {
		if (rows.length) {
			cb(true)
		} else {
			cb(false)
		}
	});
}

// send collected bytes to the accumulation address
function sendMeBytes() {
	if (!conf.accumulationAddress || !conf.minBalance)
		return console.log('Byteball no accumulation settings');
	let network = require('byteballcore/network.js');
	if (network.isCatchingUp())
		return console.log('still catching up, will not accumulate');
	console.log('will accumulate');
	db.query(
		"SELECT address, SUM(amount) AS amount \n\
		FROM my_addresses CROSS JOIN outputs USING(address) JOIN units USING(unit) \n\
		WHERE is_spent=0 AND asset IS NULL AND is_stable=1 \n\
		GROUP BY address ORDER BY amount DESC LIMIT ?",
		[constants.MAX_AUTHORS_PER_UNIT],
		rows => {
			let amount = rows.reduce((sum, row) => sum + row.amount, 0) - conf.minBalance;
			if (amount < 1000) // including negative
				return console.log("nothing to accumulate");
			const headlessWallet = require('headless-byteball');
			headlessWallet.issueChangeAddressAndSendPayment(null, amount, conf.accumulationAddress, conf.accumulationDeviceAddress, (err, unit) => {
				if (err)
					return notifications.notifyAdmin('accumulation failed', err);
				console.log('accumulation done ' + unit);
				if (rows.length === constants.MAX_AUTHORS_PER_UNIT)
					sendMeBytes();
			});
		}
	);
}

async function sendMeEther() {
	if (!conf.ethAccumulationAddress)
		return console.log('Ethereum no accumulation settings');
	let accounts = await web3.eth.getAccounts();
	let gasPrice = await web3.eth.getGasPrice();
	if (gasPrice === 0) gasPrice = 1;
	let fee = new BigNumber(21000).times(gasPrice);

	accounts.forEach(async (account) => {
		if (account !== conf.ethAccumulationAddress) {
			let balance = new BigNumber(await web3.eth.getBalance(account));
			console.error('balance', account, balance, typeof balance);
			if (balance.greaterThan(0) && balance.minus(fee).greaterThan(0)) {
				await web3.eth.personal.unlockAccount(account, conf.ethPassword);
				web3.eth.sendTransaction({
					from: account,
					to: conf.ethAccumulationAddress,
					value: balance.minus(fee),
					gas: 21000
				}, (err, txid) => {
					if (err) return console.error('not sent ethereum', account, err);
				});
			}
		}
	});
}

// for real-time only
function checkTokensBalance() {
	db.query(
		"SELECT SUM(amount) AS total_left FROM my_addresses CROSS JOIN outputs USING(address) WHERE is_spent=0 AND asset = ?",
		[conf.issued_asset],
		rows => {
			let total_left = rows[0].total_left;
			db.query("SELECT SUM(tokens) AS total_paid FROM transactions WHERE paid_out=1", rows => {
				let total_paid = rows[0].total_paid;
				if (total_left + total_paid !== conf.totalTokens)
					notifications.notifyAdmin('token balance mismatch', 'left ' + total_left + ' and paid ' + total_paid + " don't add up to " + conf.totalTokens);
			});
		}
	);
}

eventBus.on('in_transaction_stable', tx => {
	let device = require('byteballcore/device');
	const mutex = require('byteballcore/mutex');
	mutex.lock(['tx-' + tx.txid], unlock => {
		db.query("SELECT txid FROM transactions WHERE txid = ?", [tx.txid], rows => {
			if ((rows.length && rows[0].stable)) return;
			let queryOrReplace = '';
			if (tx.currency === 'ETH') queryOrReplace = 'OR REPLACE';

			if (conf.rulesOfDistributionOfTokens === 'one-time' && conf.exchangeRateDate === 'distribution') {
				db.query(
					"INSERT " + queryOrReplace + " INTO transactions (txid, receiving_address, currency, byteball_address, device_address, currency_amount, tokens, stable) \n\
					VALUES(?, ?,?, ?,?,?,?, 1)",
					[tx.txid, tx.receiving_address, tx.currency, tx.byteball_address, tx.device_address, tx.currency_amount, null],
					() => {
						unlock();
						if (tx.device_address)
							device.sendMessageToDevice(tx.device_address, 'text', texts.paymentConfirmed());
					}
				);
			}
			else {
				let tokens = conversion.convertCurrencyToTokens(tx.currency_amount, tx.currency); // might throw if called before the rates are ready
				if (tokens === 0) {
					unlock();
					if (tx.device_address)
						device.sendMessageToDevice(tx.device_address, 'text', "The amount is too small to issue even 1 token, payment ignored");
					return;
				}
				db.query(
					"INSERT " + queryOrReplace + " INTO transactions (txid, receiving_address, currency, byteball_address, device_address, currency_amount, tokens, stable) \n\
					VALUES(?, ?,?, ?,?,?,?, 1)",
					[tx.txid, tx.receiving_address, tx.currency, tx.byteball_address, tx.device_address, tx.currency_amount, tokens],
					(res) => {
						unlock();
						tx.transaction_id = res.insertId;
						tx.tokens = tokens;
						if (conf.rulesOfDistributionOfTokens === 'real-time')
							sendTokensToUser(tx);
						else if (tx.device_address)
							device.sendMessageToDevice(tx.device_address, 'text', texts.paymentConfirmed());
					}
				);
			}
		});
		if (tx.currency === 'ETH') {
			checkUserAdress(tx.device_address, 'ETHEREUM', bEthereumAddressKnown => {
				if (!bEthereumAddressKnown) device.sendMessageToDevice(tx.device_address, 'text', "Please send me your ethereum address");
			});
		}
	});
});

eventBus.on('new_in_transaction', tx => {
	let device = require('byteballcore/device.js');
	if (tx.currency === 'ETH') {
		checkUserAdress(tx.device_address, 'ETHEREUM', bEthereumAddressKnown => {
			db.query("SELECT txid FROM transactions WHERE txid = ? AND currency = 'ETH'", [tx.txid], (rows) => {
				if (rows.length) return;
				db.query(
					"INSERT INTO transactions (txid, receiving_address, currency, byteball_address, device_address, currency_amount, tokens) \n\
					VALUES(?, ?,?, ?,?,?,?)",
					[tx.txid, tx.receiving_address, tx.currency, tx.byteball_address, tx.device_address, tx.currency_amount, null], () => {
						device.sendMessageToDevice(tx.device_address, 'text', "Received your payment of " + tx.currency_amount + " " + tx.currency + ", waiting for confirmation.");
						if (!bEthereumAddressKnown) device.sendMessageToDevice(tx.device_address, 'text', "Please send me your ethereum address");
					});
			})
		});
	} else {
		device.sendMessageToDevice(tx.device_address, 'text', "Received your payment of " + tx.currency_amount + " " + tx.currency + ", waiting for confirmation.");
	}
});


eventBus.on('headless_wallet_ready', () => {
	let error = '';
	let arrTableNames = ['user_addresses', 'receiving_addresses', 'transactions'];
	db.query("SELECT name FROM sqlite_master WHERE type='table' AND name IN (?)", [arrTableNames], (rows) => {
		if (rows.length !== arrTableNames.length) error += texts.errorInitSql();

		if (conf.useSmtp && (!conf.smtpUser || !conf.smtpPassword || !conf.smtpHost)) error += texts.errorSmtp();

		if (!conf.admin_email || !conf.from_email) error += texts.errorEmail();

		if (error)
			throw new Error(error);

		setTimeout(sendMeBytes, 60 * 1000);
		setInterval(sendMeBytes, conf.accumulationInterval * 3600 * 1000);

		if (conf.ethEnabled) {
			ethereum_ins.startScan();
			setTimeout(sendMeEther, 60 * 1000);
			setInterval(sendMeEther, conf.ethAccumulationInterval * 3600 * 1000);
		}

		if (conf.rulesOfDistributionOfTokens === 'real-time') {
			setInterval(checkAndPayNotPaidTransactions, 3600 * 1000);
			setInterval(checkTokensBalance, 600 * 1000);
		}
	});
});