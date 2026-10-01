# Five More Minutes for Homey

See and control the screen time on your child's computer from your smart home.
[Five More Minutes](https://github.com/Five-More-Minutes-App/fmm-app) decides *when* a computer is
usable; this app puts it into Homey so a flow can start time, add time, end it, and react when it changes.

Free, open source (MIT), and it talks only to Five More Minutes on your own network.

> **Homey Pro only.** Five More Minutes gives plugin keys to your home network and nothing else, so the
> app has to run on a Homey that is on it. Homey Cloud and Homey Bridge cannot reach a computer in your
> home and cannot use this app.

## What you get

**One device per computer**, showing:

| Capability | |
|---|---|
| Timer running | On while time is running |
| Minutes left | Rounds up, so it never says 0 while there is time |
| Locked | On while the computer is locked |
| Connected | Whether the computer is talking to Five More Minutes |

**Flow triggers** (*When…*): a timer started (with `minutes` and `message` tags), time was added (`minutes` left),
a timer ended, the computer was locked (`minutes`), the lock ended, the computer came online, went offline.

**Flow conditions** (*And…*): timer is / isn't running, computer is / isn't locked, is / isn't connected.

**Flow actions** (*Then…*): start a timer for N minutes (with an optional message), start a timer until a clock
time, add time (or the household's usual five more), end the time now (which locks the computer), cancel the timer.

English and Swedish.

## Install

You need a Homey Pro and about five minutes.

### 1. Make a key

In the Five More Minutes portal open **Plugins**, choose the computer, name the key `Homey`, and tick the
permissions Homey should have:

| Permission | Needed for |
|---|---|
| `state:read` | **Required.** Seeing whether time is running, and the triggers and conditions |
| `timer:start` | The *Start a timer* actions |
| `timer:extend` | The *Add time* action |
| `timer:stop` | The *End the time now* action |
| `timer:cancel` | The *Cancel the timer* action |

Give it only what you will use: a key that only shows a countdown in Homey needs `state:read` and nothing
else. A key's permissions cannot be changed later; make a new one instead. The key is shown once. Copy it.

Or press **Add** on this plugin's page in the marketplace, and the portal makes the key for you.

### 2. Install the app

Until the app is in the Homey App Store, install it from source. On a computer on the same network as your Homey:

```bash
npm install -g homey
homey login
git clone https://github.com/Five-More-Minutes-App/fmm-plugin-homey
cd fmm-plugin-homey
homey app install
```

### 3. Add the computer

In the Homey app: **Devices → + → Five More Minutes → Computer**. It asks for:

- **Address of Five More Minutes**: where your Homey can reach it, e.g. `http://192.168.1.10:5072`. Typing `192.168.1.10:5072` is fine.
- **API key**: the key from step 1.

It checks both, and shows the computer's name. Add it.

## Flow ideas

- **Homework first.** *When* the kitchen button is pressed *then* start a timer for 45 minutes with the message "Homework".
- **A reward.** *When* the dishwasher is emptied (a Homey flow with a virtual button) *then* add 15 minutes.
- **Bedtime.** *When* 20:30 *and* timer is running *then* end the time now. *(The computer locks, as it would if time ran out.)*
- **Lights when time is up.** *When* a timer ended *then* set the hallway light to amber.
- **Nobody home.** *When* the last person leaves *then* cancel the timer.
- **A heads-up.** *When* minutes left drops to 5 *then* flash the desk lamp. (Use the *Minutes left* capability as a trigger in a flow.)
- **Turn off the games console.** *When* the computer was locked *then* switch off the socket the console is on.

## When it doesn't work

| You see | Do this |
|---|---|
| "The key was not accepted" | It is wrong, revoked or expired. Make a new key in the portal. If a device already exists, open it and choose **Repair** to enter the new key without removing it. |
| "only answers apps on your home network" | Homey has to be on the same network as Five More Minutes, and the address has to be its local one. |
| "Could not reach Five More Minutes" | Is it running? Can another device on the network open the address in a browser? |
| "does not have the permission this needs" | Make a new key with that permission ticked. |
| "Not possible right now: Time is already running" | A timer is running. Use *Add time*, or *Cancel the timer* first. |
| The device says it is unavailable | It could not reach Five More Minutes three times in a row. It keeps trying, and comes back by itself. If the message says the key was refused, use **Repair**. |

## How it behaves

- It holds a request open that Five More Minutes answers the moment something changes, so flows run within a
  moment of a parent pressing a button, and it makes about two requests a minute while nothing happens.
- Triggers fire only for what it **saw happen**. When the app starts it does not announce a timer that began an hour ago.
- If Five More Minutes is out of reach for a while, then comes back, it fires the triggers for what it
  missed (the timer that ended, the lock that began).
- The minutes left are kept honest between updates, and the end of a timer is noticed at the moment it ends.

## Security

- The key opens **one computer**, from your **home network only**. If it leaked, whoever held it would need to be on your network, and could only do what you ticked.
- The key is stored on your Homey in the device's private store. It is **not** a device setting, so it is never shown in the Homey app, and it is never written to a log or an error message.
- The app asks Homey for **no permissions** (no cloud, no access to other apps or devices).
- Flow actions validate their input (minutes 1–1440, a real clock time, a short message with no markup) before asking Five More Minutes.
- The pairing page keeps nothing once you press *Connect*.

## Development

```bash
npm test                 # controller, glue and manifest tests (no Homey needed)
npm run validate         # homey app validate, at debug level
npm run validate:publish # ... at publish level
npm run manifest         # check fmm-plugin.json against the marketplace rules
```

`homey app validate` is the real Homey CLI, and it passes at publish level. The rest is tested against a
stand-in for the Homey runtime (`test/fake-homey.cjs`) and a faithful mock of the Five More Minutes API
(`test/mock-fmm.mjs`).

- `lib/controller.js` follows the computer and decides what fires: no Homey in it, and most of the tests.
- `lib/client.js` and `lib/events.js` are copied from [fmm-plugin-template-node](https://github.com/Five-More-Minutes-App/fmm-plugin-template-node) as CommonJS.
- `drivers/computer/` is the Homey glue: pairing, repair, and the device.
- `.homeycompose/` holds the manifest, capabilities and flow cards; `app.json` is what `homey app build` makes of it, and is committed.

### What has and has not been tested

Tested: everything above, including 58 automated tests and Homey's own validation. **Not tested on a real
Homey Pro**: I could not run it on one. The flow-card and capability definitions pass Homey's validator, and
the code follows the Homey SDK v3 patterns, but the first install on real hardware may find something the
validator cannot. Please open an issue if it does.

## Licence

MIT. See [LICENSE](LICENSE).
