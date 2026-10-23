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
| ← → ↑ ↓ | spiller 1: løpe / se opp / rulle / dukke |
| , . - / høyre Shift | spiller 1: hopp (A/B/C) |
| W A S D | spiller 2 (Tails i «Sonic & Tails»): bevegelse |
| Mellomrom / Q / E (også Z X C) | spiller 2: hopp |
| ↓ + hopp | spindash (slipp ↓ for å fyre av) |
| Enter | start / pause |
| Esc | sonemeny |
| M / F | lyd av/på / fullskjerm |
| hopp i luften (Tails) | fly – trykk gjentatte ganger for å stige |

Med én spiller (eller i menyen) styrer begge tastatursidene samme figur. I «Sonic & Tails» styres Tails av
CPU-en til spiller 2 trykker noe. Gamepad og berøringsknapper (mobil) støttes også (gamepad nr. 2 = spiller 2).

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

- Fungerer med Sonic 3 (2 MB) og Sonic 3 & Knuckles (4 MB lock-on). Alle 12 Sonic 3-akter kan spilles og fullføres
  (akten slutter ved minibossen / sluttbossen – bosser er ikke portert).
- Figurer: Sonic, Sonic & Tails (CPU-Tails, kontroller 2 kan ta over), Tails alene (flyr/svømmer) og – med S3&K-ROM –
  Knuckles (glir, klatrer, egne ruter og startposisjoner fra S3&K-dataene).
- Portert fra originalen: fysikk for alle tre figurer, skjold/insta-shield, objektsystemet (SolidObject, TouchResponse,
  ringer, respawn), kamera og bakgrunnsdeformasjon for alle soner, vann (fysikk, luft/drukning, palettsplitt),
  animerte tiles og palettsykler, banestarter (LBZ1, ICZ1-snowboard), resultatskjerm, tidsgrense, game over.
- Angel Island har alle badniks og gimmicks. De andre sonene mangler fortsatt de fleste sonespesifikke objekter og badniks.
- Ikke portert: bosser, spesialetapper, Super/Hyper-former, S&K-sonene og musikk (YM2612/PSG) – lydeffektene er
  enkle syntetiserte erstatninger.

## Verktøy

`tools/` inneholder Node-skript brukt under reverse engineering og testing (krever ROM-sti som argument):
`render-level.mjs` (nivå til PNG), `sheet.mjs` (sprite-ark), `objinfo.mjs` (objekt-mappings/art fra kode),
`play.mjs` (kjør spillet headless med skriptet input og lagre skjermbilder; `CHAR=tails|sonic-tails`),
`test-tails.mjs` (Tails-testene).
