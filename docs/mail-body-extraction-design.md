# Estrazione generale del contenuto delle mail

Stato: nucleo implementato in `apps/mail-mirror/src/body.ts`, con persistenza,
recupero locale in lettura, migrazione a lotti e audit riproducibile. Nessuna
decisione usa LLM, embedding o frasi di segnaposto. Le alternative non confrontabili
con certezza vengono entrambe conservate, con offset per la lettura paginata.

La prima implementazione usa le rappresentazioni aggregate fornite dall'API
pubblica di mailparser; l'identità separata di ogni singola parte MIME resta
un'estensione. Anche OCR e interpretazione completa dei CSS restano estensioni:
i casi non letti o limitati sono segnalati, non dichiarati risolti.

## Obiettivi e invarianti

- Nessuna decisione dipende dall'indirizzo del mittente o richiede una frase nota.
- Un messaggio breve può essere completo; una rappresentazione lunga può essere
  composta quasi interamente da navigazione, tracking o cronologia citata.
- Importi, date, codici, negazioni e destinazioni dei link non devono essere
  riscritti, combinati arbitrariamente o persi durante la selezione.
- Ogni estrazione deve essere riconducibile ai byte originali e alla versione
  dell'estrattore. Le trasformazioni restano reversibili.
- Completezza del download e qualità del contenuto estratto sono stati distinti.

## 1. Acquisizione e rappresentazioni originali

Conservare hash della sorgente e identità delle parti MIME, distinguendo testo
semplice originale, HTML originale, alternative, parti miste e messaggi inoltrati.
Non confondere testo generato dall'HTML con una parte text/plain del mittente.
La posizione nella struttura MIME determina quali parti sono alternative e quali
sono complementari: non confrontare indiscriminatamente tutte le parti.

L'adattatore MIME deve usare API supportate; evitare dipendenze da proprietà
interne non documentate di mailparser. Decodifica charset e transfer encoding
precedono ogni confronto. Gli originali restano disponibili anche se una
successiva pulizia li esclude dal testo principale.

## 2. Estrazione HTML strutturata

Usare un DOM inerte e produrre blocchi con provenienza: paragrafi, elenchi,
tabelle con associazione tra intestazioni e celle, citazioni, link e immagini.
Escludere dal testo principale script, CSS e tracking. Conservare separatamente
testo nascosto, footer e cronologia: non eliminarli dalla fonte recuperabile.
La classificazione dei blocchi è graduata, perché footer e link possono contenere
informazioni importanti. CSS non interpretato abbassa la confidenza.

Le immagini non diventano stringhe base64 nel testo. Conservare alt significativo
e riferimenti CID; distinguere immagini decorative da contenuto potenziale.
Non aprire automaticamente link "visualizza nel browser" o immagini remote.

Imporre limiti espliciti a byte, profondità e tempo. Un limite raggiunto produce
uno stato di estrazione incompleta, mai un successo silenziosamente troncato.

## 3. Confronto delle alternative

Per ciascuna alternativa calcolare copertura dei blocchi, sovrapposizione del
contenuto, ripetizioni, proporzione di URL, markup residuo, errori di decodifica
e quota di testo accessorio. Normalizzare spazi e Unicode per il confronto,
preservando il testo originale per la lettura. Evitare una tokenizzazione che
presupponga parole separate da spazi o una lingua specifica.

Misurare il contenuto aggiunto dall'HTML dopo aver ridotto il peso di URL,
footer e duplicati. Le frasi note sono eventuali segnali diagnostici; non sono
condizioni necessarie per il recupero. Le soglie saranno calibrate sul corpus
di valutazione, non fissate come verità universali.

| Situazione | Comportamento |
| --- | --- |
| Una sola rappresentazione utilizzabile | Usarla, annotando eventuali limiti. |
| Versioni sostanzialmente equivalenti | Preferire quella più fedele e leggibile; evitare duplicati. |
| HTML con contenuto sostanziale che manca nel plain | Preferire HTML se il vantaggio è chiaro. |
| HTML più lungo solo per elementi accessori | Conservare il plain. |
| Plain con contenuto sostanziale assente nell'HTML | Non scartarlo; selezionarlo o conservare entrambe le versioni. |
| Differenze in importi, date, codici o negazioni | Segnalare divergenza e rendere disponibili entrambe. |
| Nessuna versione affidabile | Dichiarare contenuto mancante o incompleto. |

Non generare una fusione libera delle alternative: potrebbe produrre un messaggio
mai scritto dal mittente. Nei casi ambigui, presentare le alternative etichettate
e preservare la loro ricercabilità senza raddoppiare il peso dei blocchi comuni.

## 4. Limiti espliciti e possibili estensioni

L'implementazione resta deterministica anche nei casi ambigui: conserva entrambe
le rappresentazioni. Non serve un modello per forzare una scelta, né un punteggio
di similarità semantica per decidere che due versioni siano fattualmente uguali.

In futuro le mail costituite da immagini o scansioni potranno attivare un percorso
asincrono di OCR sui contenuti già locali. OCR e allegati avranno provenienza distinta dal
corpo del mittente e una propria confidenza. Fallimenti di OCR, messaggi cifrati
e contenuti disponibili solo sul server rimangono esplicitamente non risolti.

## 5. Stato, lettura e consumatori

Persistire versione e hash dell'estrattore, fonte scelta, motivazione, segnali
di qualità, alternative e blocchi esclusi, oltre allo stato del download.
Distinguere estrazione utilizzabile, ambigua, limitata e non disponibile.
Non interpretare "full" come prova che il testo sia informativo.

Lettura, ricerca, embedding, Action Center e promozione wiki consumano lo stesso
risultato di estrazione. Le loro riduzioni di testo mantengono provenienza e
ambiguità e non possono trasformare una mail incompleta in una mail completa.
Il fallback rilegge la sorgente locale prima di interpellare Mail.app; persiste
un miglioramento verificato, evitando di ripetere il recupero a ogni lettura.

## 6. Verifica e introduzione

Preparare un corpus anonimizzato con esempi reali e casi sintetici: segnaposto
mai visti, lingue diverse, plain brevissimo valido, HTML pieno di footer, parti
MIME annidate, tabelle, caratteri non latini, HTML malformato, differenze fattuali,
messaggi di sole immagini, allegati e limiti di risorse.

Separare casi di taratura e casi di verifica anche per template e mittente.
Cambiare indirizzi e riformulare segnaposto nei test deve lasciare invariata la
decisione. Misurare informazione recuperata e persa, alterazioni di dati critici,
duplicazione, frequenza dei casi ambigui, latenza, memoria e ricorso al modello.
Non valutare il sistema contando soltanto quante mail diventano più lunghe.

Eseguire inizialmente in parallelo al parser attuale senza scrivere il risultato;
revisionare un campione delle divergenze. Introdurre poi il nuovo estrattore con
versione esplicita e migrazione a lotti, backup, confronto della sorgente prima
dell'aggiornamento e invalidazione selettiva degli indici. L'audit deve scoprire
le mail con estrattore vecchio anche se i file EMLX non hanno cambiato mtime.
Attivare l'app aggiornata solo tramite il normale percorso di deployment.
