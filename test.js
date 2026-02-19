import makeWASocket from '@itsukichan/baileys'

const suki = makeWASocket({
   printQRInTerminal: false
})

if (!suki.authState.creds.registered) {
   const number = '923091731496'
   const code = await suki.requestPairingCode(number)
   console.log(code)
}
