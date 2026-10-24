# ESP I/O Lab

Lokales HTML-/JavaScript-Werkzeug für GPIO-, ADC-, SD- und Usage-Scan-Zugriffe über den vorhandenen
ESP-Flasher und seinen RAM-Stub. Kein Compiler, kein eigener Firmware-Build und
keine Flash-Schreib-/Löschoperationen. `../chips.js` und `../flasher.js` bleiben die
vorhandene Transport-/Stub-Implementierung; die neuen Registerprofile sind davon
getrennt.

## Starten

Im **Repository-Stammverzeichnis**:

```powershell
python -m http.server 8080 --bind 127.0.0.1
```

Dann in Chrome oder Edge [http://127.0.0.1:8080/io-tool/](http://127.0.0.1:8080/io-tool/)
öffnen. HTTPS funktioniert ebenfalls. Der Browser braucht Web Serial; die
Vorschau und die ausdrücklich gekennzeichnete Demo benötigen keine Hardware.
Direktes Öffnen der HTML-Datei kann je nach Browser funktionieren, der per
`fetch` nachgeladene Registerkatalog benötigt aber HTTP/HTTPS.

1. **Mit ESP verbinden** öffnet die Portauswahl. Das Tool verwendet danach
   automatisch Reset, Sync, Chiperkennung und den zum Chip gehörenden RAM-Stub.
   Ein bereits laufender Stub wird wiederverwendet.
2. Der erkannte Chip bestimmt die Boardauswahl. Das passende erste Board bzw.
   die logische Chipansicht wird angezeigt; die bedienbaren Pins werden als
   **GPIO Input, ohne Pull-Widerstand** initialisiert. Ein Boardwechsel gibt
   bisherige Ausgangstreiber frei und initialisiert die neuen Pins als Eingang.
3. Einen Kreis im Foto oder in der logischen Ansicht anklicken. Input/Output
   und Pull-Widerstände werden sofort übernommen. Outputs starten mit LOW,
   sofern sie nicht bereits einen von der Sitzung gesetzten Pegel haben.
4. Output-Pegel über **LOW/HIGH** im Pin-Panel oder über den kleinen
   **0/1-Schalter** neben der Pinspur ändern.
5. **Pause** hält nur die Messung an; gesetzte Ausgänge bleiben aktiv.
   **Trennen & Reset** deaktiviert verwaltete Ausgangstreiber, fordert einen
   Hardware-Reset an und schließt den Port. Danach kann die vorhandene Firmware
   wieder starten. Ob die automatische Reset-Sequenz funktioniert, hängt vom
   USB-Interface bzw. der Reset-Beschaltung ab.

Falls der automatische Bootloader-Einstieg nicht funktioniert: BOOT halten,
RESET drücken und erneut verbinden. Schließen/Neuladen des Browser-Tabs bietet
keine zuverlässige Gelegenheit für asynchrone Registerzugriffe; deshalb zum
Beenden den Trennen-Button verwenden oder das Board selbst zurücksetzen.

## Signale und Grenzen

- **Grün im Digitalmodus:** digitaler Wert aus `GPIO_IN` / `GPIO_IN1`. Auch bei Outputs bleibt
  der Eingangspuffer eingeschaltet. Der grüne Wert wird unabhängig vom roten
  Sollwert gelesen; Abweichungen sind damit sichtbar.
- **Rot:** vom Stub bestätigte Output-Schreibbefehle. Der Zeitstempel ist der
  Empfang der Bestätigung, kein exakt gemessener Hardware-Flankenzeitpunkt.
- Je Pin wird die letzte **Sekunde** als zeitbasierte, scrollende Stufenkurve
  mit ausblendenden Rändern angezeigt. Identische Kurven werden mit breiterem
  Rot und schmalerem Grün übereinander dargestellt. Messlücken werden nicht als
  durchgehend gemessene Pegel gezeichnet.
- Standard-Poll-Abstand **20 ms**, wählbar 10/20/50/100 ms. Pro benötigter Bank
  wird einmal gelesen, statt jeden Pin einzeln abzufragen. Zwei Banken werden
  nacheinander gelesen und erhalten eigene Zeitstempel. Messzyklen überlappen
  nicht; tatsächliche Rate und Alter der letzten Abtastung stehen im UI.
- Das ist eine Pegelverlaufsanzeige per Host-Polling. Kurze Pulse zwischen
  Abtastungen können fehlen. Es gibt keine Interrupt-Erfassung, keine
  deterministische Echtzeit oder kalibrierte Spannungsmessung.
- Register-/Transportfehler stoppen die Sitzungsmessung. Eine neue Verbindung
  ist erforderlich; fehlgeschlagene Konfigurationen werden nicht als aktiv
  angezeigt. Die UI schätzt alte Messwerte nicht als aktuelle Werte ein.
- Die RAM-Stub-Sitzung ersetzt die laufende Anwendung bis zum Reset. Bereits
  gehaltene Pads, spezielle eFuse-Zuordnungen oder abweichende Board-/Package-
  Beschaltungen sind ohne Tests am konkreten Gerät nicht abgedeckt.

## ADC-Modus

Im **Live-Pinout → Messquelle → ADC · 12 Bit** einschalten. GPIO-Digitalmessung
bleibt der Standard. Der ADC wird per Register initialisiert, jeder verfügbare
Kanal einzeln umgeschaltet und per Start-/DONE-Polling gelesen. Beim
Kanalwechsel wird eine erste Konvertierung verworfen. Die Kanäle erhalten
eigene Zeitstempel; die angezeigte Rate gilt für den ausgewählten Pin.
Der Poll-Abstand ist ein Wunschwert, kein Versprechen der tatsächlich
erreichbaren ADC-Abtastrate. ADC-Polling kann über USB deutlich langsamer als
die digitale Bankabfrage sein.

Grün zeigt **Rohwerte 0–4095** als Analogkurve; die Pin-Auswahl zeigt den
numerischen Rohwert und ADC-Einheit/Kanal. Rot bleibt bei Outputs die
Sollwertspur mit 0/1 an den Skalenenden. Es gibt keine Umrechnung in Volt,
keine Software-Spannungskalibrierung und keinen Anspruch auf einen linearen Bereich
bis 3,3 V. Hohe Spannungen können schon unterhalb der Versorgung zur Sättigung
führen. Das Abtasten verändert die GPIO-Input-/Output-Konfiguration nicht;
insbesondere kann auch ein gesetzter Ausgang analog zurückgelesen werden.
Beim C6 wird für GPIO0–6 der im TRM vorgesehene LP IO MUX mit Function 0
verwendet. Pulls, Output-Treiber und digitales Rücklesen benutzen dann den
zugehörigen LP-GPIO-Block; die gewählte Input-/Output-Funktion und der Sollpegel
bleiben erhalten. Beim Wechsel des Messmodus wird der Treiber kurz freigegeben.
Beim Zurückschalten werden die vom ADC-Treiber geänderten Registerfelder
wiederhergestellt und die Verläufe geleert, damit die Einheiten nicht vermischt
werden. Nicht-ADC-Pins erhalten keine Analogwerte oder erfundene Kurven.

| Chip | Implementierte ADC-Kanäle |
| --- | --- |
| ESP32-C3 | ADC1 auf GPIO0–4; ADC2/GPIO5 bleibt wegen der ADC2-Einschränkungen ausgenommen |
| ESP32-C6 | ADC1 auf GPIO0–6 |
| ESP32-H2 | ADC1 auf GPIO1–5; GPIO0 besitzt keinen ADC-Kanal |
| ESP32-P4 | ADC1 auf GPIO16–23; ADC2 auf GPIO49–54, sofern am Board verfügbar |
| ESP32-S3 | ADC1 auf GPIO1–10; ADC2 auf GPIO11–20; GPIO19/20 bleiben als USB-Transportpins gesperrt |

Für die anderen GPIO-Chipprofile bleibt die ADC-Option deaktiviert. Die neuen
ADC-Registersequenzen sind aus ESP-IDF v5.5.1 abgeleitet, **noch nicht am realen
Chip validiert**. Der analoge SAR-Block wird über den internen Analog-I²C-Master
initialisiert: interne Referenz-/Test-/Massepfade aus, DREF und Sample-Cycle
explizit setzen. Der Hardware-Initialcode für ATTEN3 wird aus den eFuse-
Schattenregistern gelesen und nach ESP-IDF geladen (C3: Feld + 1000,
C6/H2: Feld + 1600, P4: Feld + 1400 je Einheit; S3: Summe der vier
Differenzfelder ATTEN0–3 + 2010 für ADC1 bzw. + 2020 für ADC2).
Beim S3 wird der RTC-SAR-Controller verwendet, nicht der Digital-/DMA-Pfad.
Vor ADC1-Konvertierungen wird der Idle-Status geprüft; ADC2-Arbiterfehler
werden als Fehler gemeldet und niemals als Rohwerte ausgegeben.
Der S3-Analog-I²C-Zugriff nutzt Master 0, das Command-Bit 26 und die
ANA_CONFIG2-Initialisierung aus Espressifs S3-ROM (Release 20241011).
Beim H2 wird eFuse-Blockversion `major × 100 + minor >= 2` vorausgesetzt;
ältere Formate werden mit Diagnose abgelehnt. Der H2-SAR-Takt beträgt 800 kHz
(32-MHz-XTAL, Teiler 20 und 2). Nach DONE wartet der Stub zusätzlich 10 µs
auf die Datensynchronisation, bevor das Ergebnis gelesen wird.
Die eFuses werden ausschließlich
gelesen. Ein fehlender/unbekannter Kalibrierdatenstand führt zu einem Fehler;
die aufwendige Hardware-Selbstkalibrierung ohne Werksdaten ist nicht implementiert.
Analogschreibzugriffe werden zurückgelesen und die geänderten Felder beim
Beenden wiederhergestellt. Das ist Hardware-Offsettrim, keine Umrechnung in Volt.
Siehe [ADC-Prüfnotizen](ADC-REVIEW.md) für den gemeldeten Grundwert um 1900.
Nach einem Timeout wird kein alter Registerinhalt als neuer Messwert ausgegeben.

## Usage-Scan

Einzelnen GPIO auswählen oder **alle verfügbaren GPIOs** des Boards testen.
ADC-Pins liefern Analogwerte plus digitale Istwerte; alle anderen Pins liefern
digitales Rücklesen mit 0/1. Das funktioniert auch bei Chipprofilen ohne
implementierten ADC, z. B. S2. Dafür wird kein ADC initialisiert oder benutzt.
Speicher-, Transport- und unverwaltete Pins bleiben ausgeschlossen.
Der Scan pausiert das Polling und läuft in derselben Befehlsqueue.
Er misst zuerst die Basis ohne Pull, danach die Folge **LOW → HIGH → LOW**.
Während jedes Messfensters werden ADC und digitaler GPIO-Istwert so schnell
wie über den Registertransport möglich erfasst: ohne eingestellten Poll-Abstand,
ohne Kanalwechsel und ohne Mittelwertbildung. Pro Phase mindestens zwei,
höchstens 256 Messungen. Jede Konvertierung enthält neue START-/DONE-Zugriffe.
Ohne ADC benötigt eine Probe nur einen GPIO-Registerzugriff. Nicht verfügbare
Testmethoden werden ausgelassen: reine Input-Pins können nicht als Output
getrieben werden; Pins ohne interne Pulls erhalten keinen Pull-Test. Falls
keine gewählte Testmethode verfügbar ist, wird nur das Eingangssignal beobachtet.

- **Pull / OUT überlagern** ist die Voreinstellung. Führt dieselbe Folge zuerst
  mit Pull-down / Pull-up / Pull-down, danach mit Output LOW / HIGH / LOW aus.
  Beide Durchläufe erscheinen im selben Scope-Plot; ihre Zeitachsen beginnen
  jeweils beim Durchlaufstart. Es gibt keine nachträgliche zeitliche Streckung.
- **Pull-down / Pull-up / Pull-down** verwendet nur die internen Pull-Widerstände.
- **Output LOW / HIGH** ist die aktive Variante. Sie nutzt die kleinste
  GPIO-Treiberstärke und startet direkt über **Scan starten**, ohne Freischalt-Checkbox.
  Das ist weiterhin ein Push-Pull-Ausgang und **keine Strombegrenzung**.
  Er kann einen fremden Ausgang gegentreiben. Die Testpunkte müssen für diese
  Ansteuerung geeignet sein. Ein zusätzlich in Reihe geschalteter Widerstand
  verändert die Messanordnung: Der ESP-seitige ADC misst dann nicht direkt den
  Pegel hinter dem Widerstand; eine Klassifikation der Zielseite ist damit
  nicht unverändert gültig.

Das wählbare Messfenster beträgt 5–200 ms pro Phase; die Mindestzahl an
Messungen und der Registerverkehr können die Dauer verlängern. Pro Pin gibt es
einen Scope-Plot in der Ergebnistabelle und beim ausgewählten Pin zusätzlich
im Inspector: ADC mit Pulls grün, ADC mit OUT blau, digitaler Istwert gepunktet,
Sollwert rot (Pull gestrichelt). Linien verbinden einzelne Messpunkte;
Hover-Texte enthalten Rohwert und Zeitfenster. Kurze horizontale Balken zeigen
START-Senden bis DONE-Empfang, schattierte Bereiche die Befehlslatenz der
Ansteuerung. Die tatsächlichen Abtastabstände werden angegeben.
Ohne ADC zeigen die grünen/blauen Kurven ausschließlich digitale Istwerte
(Stufenkurve, Skala 0/1). Es gibt keine erfundenen ADC-Rohwerte. Jede Grafik
hat eine eigene Legende; die Ergebnistabelle nennt Pull- und OUT-Werte getrennt.

Es gibt keine MCU-Zeitstempel oder lokale Pufferaufnahme im unveränderten
Flasher-Stub. Die Darstellung kann langsame Flanken zeigen, aber schnelle
elektrische Flanken unterhalb der Transport-/Abtastauflösung nicht vermessen.
Ein schräges Verbindungsstück zwischen zwei Punkten ist kein gemessener
Flankenverlauf. Die JSON-Daten enthalten die Zeitgrenzen aller Konvertierungen,
separate digitale Lesezeitfenster sowie die Sende-/Bestätigungszeiten aller
Ansteuerbefehle. Das ist kein garantierter Kurzpuls. Bei Verbindungsverlust
oder Schließen des Tabs ist die Wiederherstellung nicht garantiert; ein
Testausgang kann bis zum manuellen Board-Reset aktiv bleiben.

Der Scan gibt nach jedem Pin die Testansteuerung frei und stellt IO-MUX,
GPIO-Matrix, Pulls, Interrupt-/Open-Drain-Felder, Ausgangslatch, Output-Enable
und Treiberstärke anhand zuvor gelesener Registerwerte wieder her. Das gilt
auch bei Abbruch oder ADC-Fehlern, soweit die Verbindung noch funktioniert.
Wiederherstellungsfehler werden ausdrücklich gemeldet; dann wird ein zuvor
aktiver Output nicht automatisch wieder eingeschaltet. Zuvor laufendes
Polling startet nur nach erfolgreicher Wiederherstellung bzw. normalem Abbruch
wieder. Scan-Ergebnisse und Messquelle bleiben voneinander getrennt.

Ohne ADC lautet die Einschätzung **nur digital gemessen**, ohne Last- oder
Pull-Widerstands-Analyse. Bei ADC vergleicht die grundlegende Einschätzung
die LOW-/HIGH-Differenz mit dem ADC-Rohbereich:
ab 65 % „folgt deutlich“, ab 18 % „folgt teilweise“, darunter „kaum Reaktion“;
eine umgekehrte Differenz unter −8 % wird als widersprüchlich markiert.
Das sind transparente Heuristiken, **kein Nachweis von Input oder Output**.
Eine starke Last, externe Ansteuerung, Pull-Widerstände, ADC-Sättigung oder
ein zeitveränderliches Signal können ähnliche Werte liefern. Sättigung an den
Rändern und Veränderungen zwischen frühem/spätem Messwert werden markiert.
Ein Messwert am oberen Rand beweist insbesondere keine lastfreie Leitung.

Bei **Pull + Output** werden beide Durchläufe verglichen. Wenn beide LOW-Phasen
unter Pull-down mindestens 65 % und HIGH unter Pull-up mindestens 82 % erreichen,
der Output aber LOW auf höchstens 18 % und HIGH auf mindestens 82 % bringt,
erscheint **Pull-up plausibel**. Für den umgekehrten Fall (Pull-up-HIGH höchstens
35 %, Pull-down-LOW höchstens 18 %, Output folgt) erscheint **Pull-down plausibel**.
Folgt der Pin schon den schwachen Pulls an beiden Skalenenden, steht dort
**Folgt auch schwachen Pulls**. Auch diese Aussagen sind heuristisch: Ein
externer Pull-Widerstand wird dadurch nicht sicher von aktiver Ansteuerung
unterschieden und kein Widerstandswert berechnet.

Der JSON-Export (`esp-io-usage-scan-v2`) enthält Rohdaten, Zeitstempel, Methode,
Hardwaretrim und Einschätzung für jeden Durchlauf. `measurement` unterscheidet
`adc` und `digital`; ohne ADC bleiben `raw`, `value`, `calibration` und die
analoge Differenz `null`, während `io` und die tatsächlichen Lesezeitfenster
gespeichert werden. Ausgelassene Methoden stehen in `skippedMethods`.
Demo-Ergebnisse bleiben auch nach dem Beenden der Demo als Simulation markiert.

## SD-Port: zuerst ESP32-P4

Unter **Peripherie & Register → SD** klappt das Konfigurationsmenü auf.
**D0, CMD und CLK sind Pflicht**, D1–D3 sind optional. Jede Zuordnung markiert
den GPIO oben gelb und ergänzt seine Signalbezeichnung. Die Zuordnung allein
schreibt noch keine Register. **SD-Port aktivieren** übernimmt sie;
**Karte identifizieren** aktiviert den Port bei Bedarf automatisch.
Für 4 Bit müssen D0–D3, CMD und CLK vollständig und eindeutig zugeordnet sein.
Speicher-/Transportpins und reine Eingänge sind nicht wählbar.

Die Implementierung nutzt beim P4 und S3 **SDMMC Slot 1 über die
GPIO-Matrix**, mit frei wählbaren GPIOs aus der dargestellten Boardansicht.
Die Chipansicht erlaubt auch die übrigen freigegebenen GPIOs. Slot 0 mit
festen UHS-Pads und 1,8-V-Umschaltung wird nicht verwendet. Der Host erzeugt
400 kHz aus dem üblichen P4-PLL160M-Referenztakt, Host-Teiler 2 und
Kartenteiler 100 (zweite Stufe teilt durch 2 × 100). CPU-Interrupts und DMA
bleiben aus; der Browser liest die rohen SD-Statusregister über den Stub.

Der **ESP32-S3 besitzt ebenfalls einen nativen SDMMC-Host mit zwei Slots**;
SPI ist nicht erforderlich. Beide S3-Slots unterstützen 1/4/8 Datenleitungen.
Das Tool nutzt Slot 1 in 1- oder 4-Bit-SD-Modus bei 3,3 V und 400 kHz
(PLL160M / Host-Teiler 10 / (2 × Kartenteiler 20)). S3-Register, GPIO-Signalnummern
und Takt-/Phasensteuerung sind separat aus ESP-IDF abgeleitet; P4-LDO- oder
P4-Taktregister werden dabei nicht angesprochen.
S3 SuperMini und AI-S3 haben keinen hier vorbelegten SD-Sockel: einen externen
3,3-V-SD-Sockel verdrahten und die Pins im SD-Menü frei zuordnen.
Ein Beispiel für beide Boards ist D0=GPIO4, D1=GPIO5, D2=GPIO6, D3=GPIO7,
CMD=GPIO12, CLK=GPIO13. Bei 1 Bit genügen CLK, CMD und D0 am Host; die Karte
benötigt weiterhin Pull-ups an CMD und **allen DAT0–DAT3**, auch den nicht
angeschlossenen Leitungen. Espressif empfiehlt externe 10-kΩ-Pull-ups nach
3,3 V; die internen schwachen Pull-ups ersetzen sie nicht.
Speicher-/USB-/UART-Pins bleiben gesperrt. Onboard-Peripherie und
Strapping-Pins vor dem Verdrahten prüfen.

Auf den übrigen Chips nennt das Menü den vorgesehenen nativen bzw. SPI-Pfad,
enthält jedoch **noch keine aktive SD-Steuerung**. Im SPI-Pfad wären CMD =
MOSI, D0 = MISO, CLK = SCK und D3 = CS; deshalb muss CS dort später zusätzlich
verpflichtend werden. Diese Zuordnung wird nicht als nativer 1-Bit-SD-Bus ausgegeben.

Für den **Waveshare P4-ETH** trägt **Onboard-Slot belegen** D0–D3 = GPIO39–42,
CLK = GPIO43 und CMD = GPIO44 ein. Die auswählbare Onboard-Versorgung schaltet
zusätzlich GPIO45 LOW und LDO4 in den 3,3-V-Rail-Bypass. LDO4 versorgt auch
die I/O-Domäne GPIO39–48; die Änderung betrifft daher diese gesamte Domäne.
Bei 3,3 V werden die analogen DREF-/MUL-Trimwerte vom LDO umgangen und
unverändert belassen. GPIO45 wird wie die SD-Signale mitverwaltet und gelb
markiert. Das ist boardabhängig, keine pauschale Versorgungseinstellung für
andere P4-Boards. **Vorhandene / externe 3,3 V** ändert weder LDO4 noch einen
Power-GPIO. Externe SD-Karten benötigen gemeinsame Masse sowie passende
Pull-ups an CMD/DAT, einschließlich D3 im 1-Bit-Modus.

Die Identifikation sendet CMD0 mit Initialisierungstakten, prüft CMD8 und
wartet über CMD55/ACMD41 auf Power-up-Ready. Anschließend liest sie CID,
RCA und CSD über CMD2/CMD3/CMD9, selektiert per CMD7 und prüft CMD13.
Bei gewünschter 4-Bit-Konfiguration folgt nach CMD7 zunächst CMD55/ACMD6;
erst danach schaltet der Host seine Busbreite um und verbindet D3 mit der
Peripherie. Bis dahin bleibt ein zugewiesener D3 aktiv HIGH, damit CMD0 den
nativen SD-Modus auswählt. Fehlende D3-Verdrahtung wird damit nicht ersetzt.
Legacy-SDSC ohne CMD8 wird berücksichtigt; CRC-/Hostfehler werden dabei nicht
als Legacy-Erkennung übergangen. OCR fordert keine 1,8-V-Umschaltung an.

Die Anzeige dekodiert Hersteller-ID, OEM, Produkt, Revision, Seriennummer,
Herstellungsdatum und Kapazität für SD-CSD v1/v2. Unbekannte CSD-Strukturen
bekommen keine erfundene Kapazität. Unterhalb stehen einzeln ausführbare
Kommandos mit dezimalem oder hexadezimalem 32-Bit-Argument, rohen Antworten,
Status und Laufzeiten. ACMD41 setzt CMD55 automatisch davor. RCA-Argumente
werden nach der Identifikation vorbelegt. CMD0 setzt die Karte zurück;
CMD9 setzt normalerweise eine Karte im Standby-Zustand voraus. Das Tool
erfindet für manuell unpassende Zustandsfolgen keinen Erfolg.

Zugewiesene aktive Pins sind für manuelle GPIO-Änderungen, ADC-Abtastung und
Usage-Scan gesperrt. Alle SD-Transaktionen nutzen dieselbe Befehlsqueue wie
GPIO/ADC; Registerzugriffe verschiedener Funktionen überlappen nicht.
**Port freigeben**, Abbruch und Boardwechsel lösen die Zuordnung wieder.
Pinmux, Matrixfelder, Ausgangslatch, Enable und die geänderten gemeinsamen
Takt-/LDO-Felder werden maskiert wiederhergestellt. Bei Wiederherstellungsfehlern
wird die Sitzung gestoppt und ein vorheriger Ausgang nicht wieder aktiviert.
Der SD-Controller selbst wird beim Aktivieren zurückgesetzt; ein vorheriger
Firmware-/DMA-Transferzustand oder der Karten-Protokollzustand wird dadurch
nicht wiederhergestellt. Nach Neustart der Firmware initialisiert diese ihre
Karte erneut.

Neben den **Identifikations- und Statuskommandos** steht auf P4 und S3 der
schreibgeschützte Sektordownload bereit: CMD17 liest jeweils 512 Bytes und
speichert den gewählten inklusiven LBA-Bereich als Rohabbild. Wie in ESP-IDF
empfängt der interne IDMAC des Hosts den Sektor über einen einzelnen
Deskriptor in einen festen, vom Stub/ROM ungenutzten RAM-Puffer (P4
`0x4FF78000`, S3 `0x3FCC0000`); die CPU liest ihn anschließend per Register-
Lesebefehl aus. Der P4-FIFO lässt sich per CPU nicht auslesen; dort wird der
Puffer über den nicht cachebaren Alias (`+0x40000000`) gelesen. CRC-, Timeout-
und unvollständige DMA-Daten werden vor der Dateiausgabe abgewiesen. Bei SDSC wird CMD16 für
512-Byte-Blöcke verwendet und die LBA in eine Byteadresse umgerechnet.
Es gibt keine Dateisysteme, Lösch-/Schreibkommandos oder SDIO-/eMMC-
Initialisierung. SD-Protokoll, Registerpfad, UI und Fehlerfälle
sind mit Simulation getestet. Der P4-Sektordownload (1 Bit, SDHC) ist auf
realer Hardware validiert; **S3 ist auf realer Hardware noch nicht validiert**.

Quellen: [P4 SDMMC-LL](https://github.com/espressif/esp-idf/blob/v5.5.1/components/hal/esp32p4/include/hal/sdmmc_ll.h),
[S3 SDMMC-Host und GPIO-Zuordnung](https://docs.espressif.com/projects/esp-idf/en/v5.5.1/esp32s3/api-reference/peripherals/sdmmc_host.html),
[S3 Pull-up-Anforderungen](https://docs.espressif.com/projects/esp-idf/en/v5.5.1/esp32s3/api-reference/peripherals/sd_pullup_requirements.html),
[S3 SDMMC-LL](https://github.com/espressif/esp-idf/blob/v5.5.1/components/hal/esp32s3/include/hal/sdmmc_ll.h),
[Host-Initialisierung und Pinmux](https://github.com/espressif/esp-idf/blob/v5.5.1/components/esp_driver_sdmmc/src/sdmmc_host.c),
[SD-Kommandos und Antworten](https://github.com/espressif/esp-idf/blob/v5.5.1/components/esp_driver_sdmmc/src/sdmmc_transaction.c),
[LDO-Rail-Bypass](https://github.com/espressif/esp-idf/blob/v5.5.1/components/hal/esp32p4/include/hal/ldo_ll.h),
[Waveshare-Schaltplan](https://files.waveshare.com/wiki/ESP32-P4-ETH/ESP32-P4-ETH-datasheet.pdf).

## Chips, Boards und reservierte Pins

GPIO-Registerprofile gibt es für ESP32, S2, S3, C2, C3, C5, C6, C61, H2 und P4.
Das bedeutet, dass deren Registerdefinitionen implementiert sind; eine
Hardwarevalidierung dieser Kombinationen ist noch ausstehend. Der vorhandene
Flasher muss den konkreten Chip erkennen und einen passenden Stub besitzen.
Unbekannte Chips, ESP8266 und gesondert erkannte P4-RC1-Varianten bekommen ohne
eigenes geprüftes Profil keinen GPIO-Zugriff.

Die erste Boardauswahl enthält:

| Board | Darstellung |
| --- | --- |
| C3 SuperMini | Boardfoto, 13 GPIOs am 2 × 8-Pin-Header |
| C6 SuperMini | Boardfoto, seitliche Header; GPIO21/22/23 und USB12/13 als separat beschriftete schematische Zusatzpads |
| H2 SuperMini | Boardfoto, 15 GPIOs an 2 × 9 Seitenpads; GPIO22/25/26/27 als schematische Innenpads; fehlerhaften Aufdruck „28“ als GPIO26 zugeordnet |
| S3 SuperMini | Pinout-Bildausschnitt, 15 GPIOs am 2 × 9-Pin-Header und 20 schematische Rückseitenpads; Variante mit Ladeelektronik, nicht S3 Zero |
| AI-S3 | YD-ESP32-S3-kompatibles Pinout, 36 GPIOs am 2 × 22-Pin-Header; Antenne oben, USB-Buchsen unten |
| Waveshare ESP32-P4-ETH | Herstellerfoto mit den 27 GPIOs des 40-Pin-Headers und 7 schematischen SD-/Enable-Pads |
| Roher Chip, für jedes Profil | Alle gültigen logischen GPIOs; ausdrücklich keine Gehäuse-Padnummern |

Flash-/PSRAM-Pins sind einschließlich packageabhängiger Speicherpins
konservativ reserviert. Ebenso bleiben **UART0- und USB-Pins gleichzeitig
reserviert**, unabhängig vom gewählten Transport. So werden weder die laufende
Verbindung noch ein eventuell angeschlossener USB-UART-Bridge-Ausgang durch
Pinmux-Änderungen beeinflusst. Die Chipansicht hebt diese Reservierungen nicht
auf. Dadurch stehen z. B. beim C3 SuperMini zunächst 11 der 13 Header-GPIOs zur
Verfügung. Der Grund ist pro Pin sichtbar.

Strapping-Pins sind als solche beschriftet. Versorgung, GND, EN und RUN sind
keine bedienbaren GPIOs. SuperMini ist keine einheitliche Hardware-Revision:
vor dem Verdrahten Silkscreen und tatsächliche Bestückung vergleichen.
Boardseitige LEDs und andere Peripherie bleiben elektrisch angeschlossen.

## Aufbau und Erweiterungen

- `index.html`, `style.css`, `app.js`: Oberfläche, Verbindung, Boardauswahl,
  Canvas-Verläufe, Diagnose und Registerkatalog.
- `gpio.js`: Registertransport mit Statusprüfung, serialisierte
  Konfigurationsänderungen, GPIO-Controller, begrenzter Verlauf und Demo.
- `adc.js`, `configs/adc.js`, `analog.css`: ADC-Registertreiber, Scan und
  Scan-Auswertung; getrennte ADC-Rezepte für C3/C6/P4/S3/H2.
- `sd.js`, `configs/sd.js`, `sd.css`: SD-Kartenkommandos, Identifikation,
  Sektordownload, P4-/S3-SDMMC-Rezepte, Pinverwaltung und explizites Demomodell.
- `configs/chips.js`: generierte chipabhängige GPIO-Adressen, Registermasken,
  GPIO-/RTC-/LP-Pinmux-Routen, gültige Pins und Peripherieblöcke.
- `configs/boards.js`: davon getrennte Boardzuordnungen, Bildausschnitte und
  anklickbare Pinpositionen. Hier lassen sich weitere Boards ergänzen.
- `configs/registers/<chip>.json`: vollständiger **Register-Namenskatalog der
  abgerufenen ESP-IDF-Registerheader** mit Quelle, Ausdruck und – soweit statisch
  auflösbar – Adresse. Parametrisierte/bedingte Ausdrücke bleiben symbolisch;
  der Katalog ist keine generische Register-Schreiboberfläche und behauptet
  keine vollständige Treiberunterstützung oder Registerfeldmodellierung.
- `scripts/fetch-reference.py`, `scripts/generate-chip-data.py`: reproduzierbare
  Profilgenerierung aus **ESP-IDF v5.5.1**. Die heruntergeladenen Originalheader
  liegen in `reference/` (ignoriert); die erzeugten Daten sind Bestandteil des
  Tools. SHA-256-Prüfsummen der verwendeten Header stehen pro Chip im Profil.

Die GPIO-Implementierung schaltet zuerst den Ausgangstreiber ab, wählt die
digitale GPIO-/RTC-/LP-Route, deaktiviert Interrupt/Wakeup und Open Drain,
aktiviert Eingangspuffer und IO-MUX und setzt die Ausgangsmatrix. Bei Outputs
wird der gewünschte Pegel vor dem Aktivieren des Treibers vorgeladen.
IO-MUX-/Matrix-Änderungen verwenden maskierte `WRITE_REG`-Befehle;
Output/Output-Enable verwenden die atomaren W1TS-/W1TC-Register.

I²C, SPI, RMT, PWM/LEDC, UART und I²S sind je nach Chip bereits auswählbar,
aber ausdrücklich **noch ohne Steuerung**. Ihre Auswahl verändert keine
Hardwarekonfiguration. Die bisherige GPIO-Konfiguration bleibt aktiv.
Der Registerkatalog bietet außerdem die übrigen im Profil aufgeführten Blöcke.
ADC, SD und Usage-Scan nutzen denselben serialisierten Ablauf.

Profile neu erzeugen (Python, nur für die Downloads mit Netzwerkzugriff):

```powershell
python io-tool/scripts/fetch-reference.py
python io-tool/scripts/generate-chip-data.py
python io-tool/scripts/generate-adc-data.py
python io-tool/scripts/fetch-sd-reference.py
python io-tool/scripts/generate-sd-data.py
```

## Prüfung

```powershell
node --test --test-isolation=none io-tool/tests/*.test.js
```

Die Tests prüfen reale Registeradressen wichtiger Chips, Pinbeschränkungen,
Default-Inputs, maskierte Schreibzugriffe, das Vorladen des Output-Pegels,
Bank-Readback unabhängig vom Sollwert, GPIO-Freigabe und Fehlerbehandlung.
Die ADC-Tests prüfen außerdem Kanalwechsel und Rohwerte, ADC2 beim P4 und S3,
Timeouts/alte DONE-Bits, Analog-I²C, eFuse-Initialcodes einschließlich Wortgrenzen,
die kumulative S3-Kalibrierung, S3-Idle-Timeouts und ADC2-Arbiterflags,
H2-Kalibrierversionen, beide H2-Analogmaster und verzögerte H2-Ergebnisdaten,
unbekannte Kalibrierversionen, Pull-/Output-Vergleich, Scope-Zeitgrenzen, Abbruch sowie die Wiederherstellung
einschließlich Fehlern während der Wiederherstellung.
Die SD-Tests prüfen die nativen P4-/S3-Pfade, 1-/4-Bit-Sequenzen, CID/CSD,
RCA, CRC-/Timeoutfehler, frisches CMD_DONE, Legacy-SD, Pinbelegungskonflikte,
ADC-Ausschluss, Abbruch, GPIO-/LDO-/Takt-Wiederherstellung und das P4-Onboard-Power-Gate.
Sektordownloads werden bytegenau für SDHC- und SDSC-Adressierung einschließlich
CRC-/Datenfehlern, unvollständigem DMA-Transfer, der DMA-Registersequenz und Abbruch vor unvollständigen Sektoren geprüft.

Zusätzlich gibt es `scripts/browser-check.mjs` für einen eigens gestarteten
Headless-Browser mit DevTools-Port 9235 und einen Repository-HTTP-Server auf
127.0.0.1:8088. Er prüft die Demo, Output/Readback, Platzhalter, Pause,
Registersuche, Chipansicht, reservierte Pins, C3/C6/P4/S3/H2-Layouts und mobile Breite.
ADC-Kurven, Einzel-/Gesamtscan, direkter aktiver Scan, Scope-Überlagerung, Scan-Abbruch und die
Simulationskennzeichnung im JSON-Export werden ebenfalls geprüft.
Für SD prüft der Browser Zuordnungen, gelbe Pins, Kartenidentifikation,
manuelle Kommandos, 4 Bit, die Onboard-Vorgabe, Abbruch, Freigabe,
Boardwechsel und mobile Breite.
Beide S3-Boards durchlaufen zusätzlich native 4-Bit-Identifikation und einen
bytegenau geprüften Sektordownload in eine simulierte Browser-Dateiausgabe.
Zusätzlich durchläuft er die Verbindung inklusive automatischem Stub-Start,
Chipwechsel und Abbruch gegen einen simulierten ESP-Transport; der eigentliche
Web-Serial-Portdialog und das physische Gerät werden damit nicht geprüft.
Screenshots landen im ignorierten Verzeichnis `screenshots/`.

Diese Prüfungen ersetzen **keine Validierung am realen C3, C6, P4, S3 oder H2**.

## Quellen und Bildnachweise

- [Espressif ESP-IDF v5.5.1: SoC-Register und Pinzuordnungen](https://github.com/espressif/esp-idf/tree/v5.5.1/components/soc)
- [Espressif GPIO-LL: chipabhängige Registeroperationen](https://github.com/espressif/esp-idf/tree/v5.5.1/components/hal)
- [Espressif esptool: serielles Registerprotokoll und Statusbytes](https://docs.espressif.com/projects/esptool/en/latest/esp32/advanced-topics/serial-protocol.html)
- [Waveshare: ESP32-P4-ETH-Foto und Header-Pinbelegung](https://docs.waveshare.com/ESP32-P4-ETH)
- [C3 SuperMini: Boardabbildung von arduino-projekte.info](https://arduino-projekte.info/products/esp32-c3-supermini-kompaktes-wi-fi-ble-development-board-mit-risc-v-power)
- [C6 SuperMini: Boardabbildung von arduino-projekte.info](https://arduino-projekte.info/products/esp32-c6-super-mini-kompaktes-wi-fi-6-ble-5-zigbee-dev-board-mit-risc-v-power)
- [S3 SuperMini: Pinout-Abbildung von espboards.dev](https://www.espboards.dev/esp32/esp32-s3-super-mini/)
- [AI-S3: Pinout und Schaltplan, Xylopyrographer/BitsNThings](https://github.com/Xylopyrographer/BitsNThings/tree/main/AI-S3%20ESP32-S3%20Dev%20Board)
- [Espressif S3-ROM: Analog-I²C-Master und Kommandowort](https://github.com/espressif/esp-rom-elfs/releases/tag/20241011)

Siehe auch `THIRD_PARTY.md`. Bildnachweise sind direkt im Tool verlinkt.
