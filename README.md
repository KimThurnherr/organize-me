# Flechte

Kleine Haushalts-PWA für zwei Personen: wiederkehrende Aufgaben mit fester Zuständigkeit (alle n Tage oder als Monatsregel wie «jeden 1. Mittwoch, Erinnerung am Vorabend») samt Verlauf und Monatsstatistik, tägliche Gesundheits-Checkliste pro Person mit Monatsstatistik, To-dos, Essensplan (sonntags für die nächste Woche planen), gemeinsame Einkaufsliste, Gäste-Rhythmus (jede Woche jemand zu Gast), gemeinsames Wochenziel mit Punkten und Serie, Pflanzen mit Jahres-Pflegeplan (per Claude erstellt), Web-Push morgens, mittags und abends und eine MCP-Schnittstelle, über die sich alles aus einem KI-Assistenten heraus pflegen lässt.

Ohne externe Abhängigkeiten: Node 24 (`node:http`, `node:sqlite`, `node:crypto`). Web-Push (RFC 8291/8292) ist selbst implementiert, VAPID-Schlüssel und Session-Secret werden beim ersten Start erzeugt und im Datenvolume gespeichert.

## Konfiguration

| Variable | Beispiel | Zweck |
|---|---|---|
| `PUBLIC_URL` | `https://app.example.com` | Öffentliche Adresse (für Login-Redirect und Cookies) |
| `ALLOWED_USERS` | `alex:alex@example.com,sam:sam@example.com` | Schlüssel und Google-Adresse der erlaubten Personen. Die Standard-Aufgaben gehen an die erste Person, Entsorgung an die zweite. |
| `USER_NAMES` | `alex:Alex,sam:Sam` | Anzeigenamen |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | | OAuth-Client (Webanwendung), Redirect-URI `<PUBLIC_URL>/auth/callback` |
| `GITHUB_REPO` / `GITHUB_REF` | `owner/repo`, `main` | Woher der Container den Code beim Start holt |
| `BIND_ADDR` / `HOST_PORT` | `127.0.0.1`, `8080` | Wo der Port auf dem Host veröffentlicht wird (hinter einem Reverse Proxy mit TLS betreiben) |
| `MCP_TOKENS` | `shared:<token>` oder `alex:<token>,sam:<token>` | Bearer-Tokens für die MCP-Schnittstelle unter `/mcp` (mind. 32 Zeichen): ein gemeinsames Token, bei dem die Person pro Aufruf angegeben wird, oder eines pro Person. Ohne Eintrag ist die Schnittstelle gesperrt. |
| `GUEST_REMIND_DAYS` / `GUEST_REMIND_REPEAT` | `60`, `14` | Erinnerung im Abend-Push, wenn jemand so viele Tage nicht mehr zu Gast war, danach alle n Tage wiederholt |
| `ANTHROPIC_API_KEY` | | Anthropic-API-Key für die Pflegepläne der Pflanzen. Bleibt auf dem Server. Ohne Key lassen sich Pflanzen nur mit eigenem Plan (MCP oder von Hand) erfassen. |
| `ANTHROPIC_MODEL` | `claude-haiku-5-5` | Modell für die Pflegepläne |
| `PLANT_REGION` | `Mitteleuropa` | Region bzw. Klima, auf das die Pflegepläne abgestimmt werden |
| `PLANT_AI_PER_HOUR` | `30` | Höchstens so viele Pflegepläne pro Stunde |
| `WEATHER_LAT` / `WEATHER_LON` / `WEATHER_PLACE` | | Optionaler Vorgabe-Ort für die Wetterprognose. Normalerweise wird der Ort in der App unter «Einstellungen» gesetzt (wird in der Datenbank gespeichert). |
| `FROST_LOOKAHEAD` | `3` | Frost innerhalb so vieler Tage (heute eingeschlossen) löst die Erinnerung zum Reinholen aus |
| `TZ` | `Europe/Zurich` | Zeitzone für Fälligkeiten und Push-Zeiten |

## Lokal starten

```sh
ALLOWED_USERS="alex:alex@example.com,sam:sam@example.com" DEV_LOGIN=1 PORT=8080 node server.js
# Anmelden ohne Google: http://localhost:8080/auth/dev?u=alex
```

`DEV_LOGIN` nie produktiv setzen.

## Deployment

`docker-compose.yml` startet `node:24-alpine`, lädt den Code als Tarball aus dem Repo und startet `server.js`. Nach einem Push genügt ein Neustart des Containers.

## iPhone

Push funktioniert nur, wenn die Seite in Safari über «Teilen» → «Zum Home-Bildschirm» installiert und von dort geöffnet wurde (iOS 16.4 oder neuer).

## MCP-Schnittstelle

`POST <PUBLIC_URL>/mcp` (Streamable HTTP, JSON-Antworten, zustandslos) mit `Authorization: Bearer <token>`. Mit einem persönlichen Token handelt der Aufruf im Namen dieser Person, mit dem gemeinsamen Token gibt der Parameter `person` an, wer handelt (erledigte Aufgaben zählen ohne Angabe für die zuständige Person). Werkzeuge: Überblick, Haushaltsaufgaben (anlegen, ändern, löschen, erledigen, nachtragen, Verlauf, Statistik), Gesundheits-Checkliste (Punkte verwalten, abhaken, Statistik), To-dos, Essensplan lesen und setzen, Einkaufsliste, Gäste und Besuche, Push-Zeiten und Teamziel, Pflanzen und Pflegeschritte (`add_plant` erstellt den Plan ohne mitgegebene Schritte per KI), Frostwarnung (`frost_min`, `set_plant_frost`, `get_weather`, Ort über `update_settings`). Begrenzt auf 120 Anfragen pro Minute und Token.

## Pflanzen

Pflanze und optional Standort eingeben, die App lässt von Claude einen Jahres-Pflegeplan erstellen (Rückschnitt, Winterschutz, Düngen, Giessen usw.). Jeder Pflegeschritt hat ein Zeitfenster (TT.MM. bis TT.MM., auch über den Jahreswechsel) und ist entweder einmal pro Fenster oder alle n Tage innerhalb des Fensters fällig. Fällige Schritte erscheinen auf «Heute» und im Morgen-Push beider Personen: einmalige zu Beginn des Fensters, danach wöchentlich und am letzten Tag, wiederkehrende am Fälligkeitstag. Ein fälliger Schritt gibt 5 Punkte. Pläne lassen sich von Hand anpassen oder neu erstellen. In der Liste sind die Pflanzen zugeklappt und zeigen nur ihren Status, aufgeklappte merkt sich das Gerät.

### Frostwarnung

Pflanzen, die draussen überwintern, aber starken Frost nicht sicher vertragen, bekommen eine Frostschwelle in °C (von Hand oder als Vorschlag der KI beim Pflegeplan). Unter «Einstellungen» wird der Ort gesetzt (PLZ und Ort, gesucht über die Open-Meteo-Ortssuche, oder Koordinaten). Die App holt alle paar Stunden die Tiefstwerte der nächsten 10 Tage bei Open-Meteo (ohne Schlüssel). Liegt ein Tag innerhalb von `FROST_LOOKAHEAD` Tagen bei oder unter der Schwelle, erscheint «vor Frost reinholen» auf «Heute» und im Push beider Personen (morgens, und abends wenn der Frost in der kommenden Nacht beginnt). Nach «Reingeholt» meldet die App, sobald kein Frost mehr in Sicht ist, dass die Pflanze wieder raus kann. Rechtzeitiges Quittieren gibt 5 Punkte. Ist die Prognose älter als 36 Stunden, gibt es keine Warnungen, sondern einen Hinweis.
