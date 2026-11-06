module.exports = function CardUser(mod) {

	const path = require('path'),
		fs = require('fs'),
		command = mod.command || mod.require.command

	const MAX_CARDS = 20
	const DEFAULT_BATCH = 8          // nb de piles de cartes par contrat de dismantle
	const DISMANTLE_CONTRACT = 90    // type de contrat vu dans tes logs
	const STEP_TIMEOUT = 5000        // abandon si le serveur ne repond plus
	const ADD_ITEM_OPCODE = 64765    // C_RQ_ADD_ITEM_TO_DECOMPOSITION_CONTRACT (vu dans tes logs)
	const ADD_UNK1 = 0               // octets 4-7 du paquet, valeur inconnue
	const ADD_UNK2 = 0               // octets 8-11 du paquet, valeur inconnue

	let gameId,
		enabled = false,
		scanning = false,
		grabItem = false,
		sniff = false,
		chatMode = null,
		tempID = null,
		itemconfig,
		invenItems = [],
		queue = [],
		dismantle = null

	const cardCount = new Map()

	try {
		itemconfig = require('./itemconfig.json')
	} catch (e) {
		itemconfig = {
			"delay": "250",
			"itemList": [
				201032, 201033, 201034, 201035, 201043,
				209901, 209902, 209903, 209904, 209905, 209923
			]
		}
		saveItems()
	}

	if (!Array.isArray(itemconfig.blacklist)) itemconfig.blacklist = []

	const cardItems = new Set(itemconfig.itemList)
	const isBlacklisted = id => itemconfig.blacklist.includes(id)

	mod.hook('S_LOGIN', 14, event => { gameId = event.gameId })

	mod.hook('S_CARD_DATA', 1, event => {
		event.cards.forEach(c => cardCount.set(c.id, c.quantity))
	})

	mod.hook('S_ITEMLIST', 4, event => {
		if ((enabled || scanning) && event.container !== 14) {
			invenItems = invenItems.concat(event.items)
		}
	})

	// Recupere un item linke dans le chat pour "card bl" / "card show" (le message n'est pas envoye)
	mod.hook('C_CHAT', '*', event => {
		if (!chatMode) return
		const m = /#####(\d+)@/.exec(event.message)
		if (!m) return

		const id = Number(m[1])
		const mode = chatMode
		chatMode = null

		if (mode === 'bl') {
			const i = itemconfig.blacklist.indexOf(id)
			if (i === -1) {
				itemconfig.blacklist.push(id)
				command.message('Item ' + id + ' added to blacklist.')
			} else {
				itemconfig.blacklist.splice(i, 1)
				command.message('Item ' + id + ' removed from blacklist.')
			}
			saveItems()
		} else {
			command.message('Item ' + id + ': '
				+ (cardItems.has(id) ? 'in card list' : 'not in card list')
				+ ', ' + (isBlacklisted(id) ? 'BLACKLISTED' : 'not blacklisted')
				+ ', registered ' + (cardCount.get(id) || 0) + '/' + MAX_CARDS)
		}
		return false
	})

	mod.hook('C_USE_ITEM', 3, event => {
		if (!grabItem) return
		if (itemconfig.itemList.includes(event.id)) {
			command.message('Card already in config, will start using now.')
		} else {
			tempID = event.id
			command.message('Using Card ID ' + event.id + ' now.')
		}
		start()
	})

	// ---------------------------------------------------------------- utilisation

	function start() {
		grabItem = false
		enabled = true
		invenItems = []
		queue = []
		mod.send('C_SHOW_ITEMLIST', 1, { gameId: gameId })
		setTimeout(buildQueue, 1500)
	}

	function buildQueue() {
		if (!enabled) return

		const planned = new Map(cardCount)

		for (const item of invenItems) {
			if (isBlacklisted(item.id)) continue
			const isCard = cardItems.has(item.id)
			if (!isCard && item.id !== tempID) continue

			let n = item.amount || 1
			if (isCard) {
				const have = planned.get(item.id) || 0
				n = Math.min(n, MAX_CARDS - have)
				if (n <= 0) continue
				planned.set(item.id, have + n)
			}
			for (let i = 0; i < n; i++) queue.push({ id: item.id, dbid: item.dbid })
		}

		if (queue.length === 0) {
			enabled = false
			command.message('No Card to use (all cards are at ' + MAX_CARDS + ').')
			return
		}
		command.message('Using ' + queue.length + ' card(s).')
		useNext()
	}

	function useNext() {
		if (!enabled) return
		const it = queue.shift()
		if (!it) {
			enabled = false
			command.message('Done.')
			return
		}

		mod.toServer('C_USE_ITEM', 3, {
			gameId: gameId,
			id: it.id,
			dbid: it.dbid,
			amount: 1
		})

		if (cardItems.has(it.id)) cardCount.set(it.id, (cardCount.get(it.id) || 0) + 1)

		setTimeout(useNext, Number(itemconfig.delay))
	}

	// ------------------------------------------------------------------ dismantle

	// Scanne l'inventaire puis calcule le surplus (cartes qui ne peuvent plus etre utilisees).
	function startDismantle(previewOnly) {
		if (dismantle) return command.message('Dismantle already running (use "card stop" to cancel).')
		if (enabled) return command.message('Card usage is running, wait for it to finish first.')

		scanning = true
		invenItems = []
		mod.send('C_SHOW_ITEMLIST', 1, { gameId: gameId })
		setTimeout(() => {
			scanning = false
			planDismantle(previewOnly)
		}, 1500)
	}

	function planDismantle(previewOnly) {
		const planned = new Map(cardCount)
		const surplus = []
		let total = 0

		for (const item of invenItems) {
			if (!cardItems.has(item.id) || isBlacklisted(item.id)) continue

			const amount = item.amount || 1
			const have = planned.get(item.id) || 0
			const usable = Math.max(0, Math.min(amount, MAX_CARDS - have))
			planned.set(item.id, have + usable)

			const extra = amount - usable
			if (extra > 0) {
				surplus.push({ id: item.id, dbid: item.dbid, amount: extra })
				total += extra
			}
		}

		if (surplus.length === 0) {
			command.message('No surplus card to dismantle.')
			return
		}

		if (previewOnly) {
			command.message(total + ' card(s) in ' + surplus.length + ' stack(s) would be dismantled:')
			surplus.forEach(s => command.message(' - ' + s.id + ' x' + s.amount))
			return
		}

		command.message('Dismantling ' + total + ' card(s) in ' + surplus.length + ' stack(s).')
		dismantle = { pending: surplus, batch: [], contract: null, timer: null, done: 0 }
		nextBatch()
	}

	function armTimer() {
		if (!dismantle) return
		clearTimeout(dismantle.timer)
		dismantle.timer = setTimeout(() => endDismantle('Dismantle aborted: no answer from server.'), STEP_TIMEOUT)
	}

	function endDismantle(msg) {
		if (!dismantle) return
		clearTimeout(dismantle.timer)
		dismantle = null
		if (msg) command.message(msg)
	}

	function nextBatch() {
		if (!dismantle) return
		if (dismantle.pending.length === 0) {
			return endDismantle('Dismantle done (' + dismantle.done + ' stack(s)).')
		}

		const size = Number(itemconfig.batch) || DEFAULT_BATCH
		dismantle.batch = dismantle.pending.splice(0, size)
		dismantle.contract = null

		armTimer()
		mod.toServer('C_REQUEST_CONTRACT', '*', {
			type: DISMANTLE_CONTRACT,
			target: 0,
			value: 0,
			name: '',
			data: Buffer.alloc(0)
		})
	}

	function addNext() {
		if (!dismantle) return
		const it = dismantle.batch.shift()
		if (!it) return commit()

		armTimer()
		// Pas de definition dans tera-data : on construit le paquet brut (32 octets), layout releve avec "card sniff"
		const buf = Buffer.alloc(32)
		buf.writeUInt16LE(32, 0)                       // longueur
		buf.writeUInt16LE(ADD_ITEM_OPCODE, 2)          // opcode
		buf.writeUInt32LE(ADD_UNK1, 4)                 // inconnu (compteur ? 96, 97 dans les echantillons)
		buf.writeUInt32LE(ADD_UNK2, 8)                 // inconnu (variable, non relie au slot)
		buf.writeUInt32LE(dismantle.contract, 12)
		buf.writeBigUInt64LE(BigInt(it.dbid), 16)
		buf.writeUInt32LE(it.id, 24)
		buf.writeUInt32LE(it.amount, 28)
		mod.toServer(buf)
		dismantle.done++
	}

	function commit() {
		if (!dismantle) return
		armTimer()
		// Comme dans tes logs : on commit directement, sans C_RQ_START_SOCIAL_ON_PROGRESS_DECOMPOSITION
		mod.toServer('C_RQ_COMMIT_DECOMPOSITION_CONTRACT', '*', { contract: dismantle.contract })
	}

	mod.hook('S_REQUEST_CONTRACT', '*', event => {
		if (!dismantle || dismantle.contract !== null || event.type !== DISMANTLE_CONTRACT) return
		dismantle.contract = event.id
		addNext()
	})

	mod.hook('S_RP_ADD_ITEM_TO_DECOMPOSITION_CONTRACT', 'raw', (code, data) => {
		if (sniff) console.log('[card sniff] S_RP_ADD_ITEM ' + data.toString('hex'))
		if (dismantle && dismantle.contract !== null) addNext()
	})

	mod.hook('S_RP_COMMIT_DECOMPOSITION_CONTRACT', 'raw', () => {
		if (!dismantle) return
		clearTimeout(dismantle.timer)
		setTimeout(nextBatch, Number(itemconfig.delay) || 250)
	})

	// Outil de debug : affiche le contenu brut du paquet quand tu ajoutes une carte a la main au dismantle
	mod.hook('C_RQ_ADD_ITEM_TO_DECOMPOSITION_CONTRACT', 'raw', (code, data, fromServer, fake) => {
		if (!sniff || fake) return
		console.log('[card sniff] C_RQ_ADD_ITEM_TO_DECOMPOSITION_CONTRACT ' + data.toString('hex'))
		if (data.length >= 32) {
			const id = data.readUInt32LE(24)
			console.log('[card sniff] u32@4=' + data.readUInt32LE(4) + ' u32@8=' + data.readUInt32LE(8)
				+ ' contract@12=' + data.readUInt32LE(12) + ' dbid@16=' + data.readBigUInt64LE(16)
				+ ' id@24=' + id + ' amount@28=' + data.readUInt32LE(28))
			invenItems.filter(i => i.id === id).forEach(i =>
				console.log('[card sniff] inventory item: ' + JSON.stringify(i, (k, v) => typeof v === 'bigint' ? v.toString() : v)))
		}
		command.message('Packet logged in console (' + data.length + ' bytes).')
	})

	// ------------------------------------------------------------------- commande

	command.add('card', (arg, value) => {
		switch (arg) {
			case undefined:
				start()
				command.message('Using card automatically now.')
				break
			case "delay":
				itemconfig.delay = value
				command.message('Delay set to ' + itemconfig.delay + 'ms')
				break
			case "id":
				grabItem = true
				command.message('Press the card you want to use automatically.')
				break
			case "stop":
				enabled = false
				queue = []
				endDismantle()
				command.message('Stopping module.')
				break
			case "dismantle":
			case "dis":
				startDismantle(value === 'list')
				break
			case "bl":
				if (value === 'list') {
					command.message('Blacklist: ' + (itemconfig.blacklist.join(', ') || 'empty'))
				} else {
					chatMode = 'bl'
					command.message('Link the item in chat to add/remove it from the blacklist.')
				}
				break
			case "show":
				chatMode = 'show'
				command.message('Link the item in chat to show its info.')
				break
			case "batch":
				itemconfig.batch = Math.max(1, Number(value) || DEFAULT_BATCH)
				command.message('Dismantle batch set to ' + itemconfig.batch + ' stack(s) per contract')
				break
			case "sniff":
				sniff = !sniff
				command.message('Sniff ' + (sniff ? 'ON: add one card manually in the dismantle window' : 'OFF'))
				if (sniff) {
					// scan l'inventaire pour pouvoir comparer le paquet avec les champs de l'item
					scanning = true
					invenItems = []
					mod.send('C_SHOW_ITEMLIST', 1, { gameId: gameId })
					setTimeout(() => { scanning = false }, 1500)
				}
				break
		}
		saveItems()
	})

	function saveItems() {
		fs.writeFile(path.join(__dirname, 'itemconfig.json'), JSON.stringify(itemconfig, null, 4), () => {})
	}
}