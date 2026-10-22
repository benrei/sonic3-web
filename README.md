# Sonic 3 – web-port

En nettleserversjon av *Sonic the Hedgehog 3* (Mega Drive, 1994) bygget ved å reverse-engineere den originale ROM-en.
Spillet inneholder **ingen** spilldata: grafikk, paletter, nivåkart, kollisjonsdata, ringer, objektplasseringer og
Sonic-animasjoner leses direkte fra brukerens egen ROM (`Sonic_The_Hedgehog_3.bin`, sjekksum `$3AE0`) når den lastes inn.

## Kjøre

```sh
bun run dev        # statisk server på http://localhost:8333 (PORT=… for annen port)
bun run test       # fysikktestene (forventer ROM i .local/sonic3.bin)
bun run play -- 0 "none:60,right:200" /tmp/shot 250   # headless kjøring + skjermbilde
```

Åpne http://localhost:8333 og velg ROM-filen (huskes i IndexedDB), eller bruk
`http://localhost:8333/?rom=.local/sonic3.bin` til lokal testing.
Ingen byggesteg – rene ES-moduler, som også kjører i Node.

## Kontroller

| Tast | Handling |
| --- | --- |
| ← → | løpe |
| ↓ | rulle (i fart) / dukke |
| ↓ + hopp | spindash (slipp ↓ for å fyre av) |
| Z / X / C / Mellomrom | hopp (A/B/C) |
| Enter | start / pause |
| Esc | sonemeny |
| M / F | lyd av/på / fullskjerm |

Gamepad og berøringsknapper (mobil) støttes også.

## Hvordan ROM-en ble forstått

Utgangspunktet var den offentlige disassemblyen (sonicretro/skdisasm, `s3.asm`). Etiketter som `loc_105F8` er ekte
ROM-adresser, men datatabeller har bare navn – så adressene ble funnet ved å lete opp instruksjonene som refererer
til dem i maskinkoden (f.eks. `lea (LevelLoadBlock).l,a2` = `45F9 0005AB0C` ved `$1A788`). Se `src/rom.js` for hele kartet.

| Data | Format | Kode |
| --- | --- | --- |
| 8x8-tiles | Kosinski Moduled (KosM) | `decomp.js` |
| 16x16-blokker, 128x128-chunks | Kosinski | `decomp.js`, `level.js` |
| Objekt-/HUD-grafikk | Nemesis (PLC-lister), KosM (badniks) | `decomp.js`, `level.js` |
| Nivåkart | `$1000` byte layout med rad-pekere (FG/BG) | `level.js` |
| Kollisjon | indeks per blokk → høydekart + vinkel | `level.js`, `player.js` |
| Sprites | S3K-mappings + DPLC (Sonic, Rhinobot) | `rom.js`, `game.js` |

Sonics fysikk (`src/player.js`) er en rutine-for-rutine-port av `Obj_Sonic`, `Player_AnglePos`, `FindFloor`/`FindWall`
osv. med samme 8.8 fastpunkt-matematikk. `src/vdp.js` er en liten programvare-VDP (to plan + sprites med prioritet).

## Status / begrensninger

- Angel Island akt 1 er mest komplett (inkl. parallax-bakgrunn tilpasset `AIZ1_Deform`). De andre sonene kan spilles,
  men bruker generisk bakgrunnsscrolling og mangler de fleste sonespesifikke objekter.
- Implementerte objekter: ringer, monitorer, fjærer, pigger, banebyttere (loop-lag), steiner, plattformer, sjekkpunkt,
  Rhinobot, Bloominator, Monkey Dude. Lianer, bosser, vann, skjold-grafikk, animerte tiles og palettsykling mangler.
- Musikk (YM2612/PSG) er ikke emulert – lydeffektene er enkle syntetiserte erstatninger.

## Verktøy

`tools/` inneholder Node-skript brukt under reverse engineering og testing (krever ROM-sti som argument):
`render-level.mjs` (nivå til PNG), `sheet.mjs` (sprite-ark), `objinfo.mjs` (objekt-mappings/art fra kode),
`play.mjs` (kjør spillet headless med skriptet input og lagre skjermbilder).
