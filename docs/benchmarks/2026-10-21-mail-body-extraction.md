# Verifica dell'estrazione dei corpi mail — 21 ottobre 2026

Estrattore versione 2: confronto deterministico delle rappresentazioni MIME,
senza LLM, embedding di confronto, regole per mittente o dizionari di segnaposto.

## Corpus reale ed esito

| Gruppo | Mail | Utilizzabili | Alternative conservate | Contenuto grafico limitato |
| --- | ---: | ---: | ---: | ---: |
| Vecchi segnaposto testuali | 399 | 0 | 399 | 0 |
| HTML dichiarato come testo | 237 | 237 | 0 | 0 |
| Corpi precedentemente vuoti | 697 | 686 | 0 | 11 |
| Mail recenti di controllo | 100 | 47 | 53 | 0 |
| Totale | 1.433 | 970 | 452 | 11 |

Nessun errore di parsing, identità MIME o verifica dei contenuti attesi negli
esempi Fiscozen. Questo non è un giudizio umano completo sul significato di tutte
le mail: il confronto col vecchio corpo è diagnostico e i casi con bassa copertura
sono stati registrati separatamente per revisione.

Tra i 399 casi di segnaposto ci sono 116 mail Fiscozen, 150 PayPal, 62 Eurospin,
11 Regione Lazio, 5 IONOS e altri mittenti. Il motore non consulta questi indirizzi:
il raggruppamento serve soltanto a descrivere il corpus di verifica.

Esempi controllati:

- Fiscozen, "Detrazione rifiutata": presenti le istruzioni di caricamento delle
  spese, la quietanza di pagamento, il riferimento al modello redditi e il link.
- Fiscozen, "Completa il pagamento": presenti l'avviso di addebito fallito e il
  collegamento "Paga ora".
- Grafico SVG inoltrato: conservati titolo ed etichette numeriche, escludendo
  contenuto eseguibile.
- Notifiche Teams: rimossi CSS e dati di script precedentemente finiti nel testo;
  il messaggio della notifica resta leggibile.

La strategia è volutamente conservativa: 53 delle 100 mail di controllo conservano
entrambe le rappresentazioni. "Ambigua" significa che la copertura esatta non è
dimostrata, non che sia stata accertata una contraddizione. Si accetta più testo
in lettura per evitare di eliminare informazioni valide. Gli offset consentono di
aprire direttamente ciascuna alternativa nella lettura paginata.

Gli 11 casi grafici non sono dichiarati letti integralmente: sono conservati i
riferimenti/descrizioni delle immagini e i relativi allegati; non è stato eseguito
OCR. L'interpretazione completa dei fogli CSS resta fuori da questa implementazione.

## Applicazione e verifiche

Il piano verificato è stato applicato a 1.433 righe, senza saltarne nessuna:
1.420 corpi modificati e 13 aggiornamenti dei soli metadati. Salvati i valori
precedenti prima della prima scrittura. Verificati nuovamente gli hash MIME e
1.433 letture dal database. Nessuna modifica a messaggi originali, thread o flag.

Confermate ricerca FTS e ricerca per sottostringa di "quietanza" sulla mail
Fiscozen. Tutti i corpi aggiornati hanno versione e hash del testo coerenti.
Le modifiche del testo invalidano il relativo embedding; i soli metadati no.
Completata anche la rigenerazione dell'indice semantico esistente: gli hash degli
embedding sono coerenti con il corpo corrente per tutte le 1.433 mail del corpus.

Controlli automatici: 93 test del mirror e 120 test del lettore, tutti superati,
oltre ai controlli TypeScript dei due servizi. I test includono mittenti e frasi
mai visti, più lingue, importi e date discordanti, negazioni, codici, destinazioni
dei link, SVG, tabelle, MIME misto, HTML malformato, limiti di risorse, migrazione
senza variazioni di mtime, persistenza e recupero locale prima di Mail.app.

Preparati i 20 servizi del pacchetto Steward e verificato l'avvio della CLI
impacchettata su un database temporaneo isolato. L'app installata non è stata
sostituita: l'autorizzazione al deployment era stata rifiutata. La nuova logica
sarà attiva per le importazioni dell'app dopo l'installazione del pacchetto.

## Riproduzione

I dati reali e i backup restano nei report locali privati, esclusi dal repository.

```sh
node --import tsx tools/eval-mail-body.mts --reference=PATH/TO/before.json --controls=100
node --import tsx tools/eval-mail-body.mts --apply-plan=PATH/TO/plan.json
```

Per un nuovo lotto, indipendente dal corpus precedente:

```sh
node --import tsx tools/eval-mail-body.mts --pending --limit=500
```

La migrazione ordinaria riesamina fino a 50 estrazioni vecchie per riconciliazione;
il lettore aggiornato recupera anche su richiesta, verificando versione e hash.
