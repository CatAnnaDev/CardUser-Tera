module.exports = function CardUser(mod) {

	const path = require('path'),
		fs = require('fs'),
		command = mod.command || mod.require.command

	const MAX_CARDS = 20

	let gameId,
		enabled = false,
		grabItem = false,
		tempID = null,
		itemconfig,
		invenItems = [],
		queue = []

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

	const cardItems = new Set(itemconfig.itemList)

	mod.hook('S_LOGIN', 14, event => { gameId = event.gameId })

	mod.hook('S_CARD_DATA', 1, event => {
		event.cards.forEach(c => cardCount.set(c.id, c.quantity))
	})

	mod.hook('S_ITEMLIST', 4, event => {
		if (enabled && event.container !== 14) {
			invenItems = invenItems.concat(event.items)
		}
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

	function saveItems() {
		fs.writeFile(path.join(__dirname, 'itemconfig.json'), JSON.stringify(itemconfig, null, 4), () => {})
	}

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
				command.message('Stopping module.')
				break
		}
		saveItems()
	})
}
