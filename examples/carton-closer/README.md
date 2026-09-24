# Fermeuse de cartons (exemple de programmation orientée objet)

Un carton arrive sur le convoyeur d'entrée et s'arrête contre une **butée**. La machine plie
les **rabats latéraux**, puis les **rabats avant/arrière**, **presse** le carton pendant
l'**encollage**, puis efface la butée et évacue le carton.

| Fichier | Contenu |
|---|---|
| `Tags.scl` | entrées / sorties (`%I`, `%Q`) et compteur de production `%MD10` |
| `Cylinders.scl` | interface `"ICylinder"` et trois vérins qui l'implémentent |
| `Sequence.scl` | FB `"CartonCloser"` : marche/arrêt, arrêt d'urgence, défauts, séquence (`CASE`) |
| `Main.scl` | instances des vérins, DB d'instance `"Machine"`, OB cyclique |
| `project/` | le même programme en projet VirtualPLC Studio (*Projet > Ouvrir*) |

Programmation orientée objet (IEC 61131-3 édition 3) :

- `INTERFACE "ICylinder"` : `Extend()`, `Retract()`, `IsExtended()`, `IsRetracted()`,
  `InFault()`, `Reset()` ;
- `"Cylinder"` : vérin avec un capteur par position et surveillance du temps de mouvement ;
- `"CylinderOneSensor" EXTENDS "Cylinder"` : un seul capteur, redéfinit `IsRetracted()`
  (temporisation) et appelle le code du bloc de base avec `SUPER()` ;
- `"BistableCylinder" EXTENDS "Cylinder"` : distributeur à deux bobines ;
- la séquence reçoit des références `"ICylinder"` : elle appelle `Press.Extend()` sans savoir
  quel type de vérin est câblé, et parcourt un `Array[1..4] of "ICylinder"` pour
  l'acquittement et la surveillance.

Pupitre : `BP_Start` (marche), `BP_Stop` (NF, arrêt en fin de cycle), `AU_Ok` (NF, arrêt
d'urgence), `BP_Reset` (acquittement). Voyants `H_Running` et `H_Fault` (clignotant).

Le test `sdk/test/examples.test.ts` fait tourner le programme avec un modèle de la machine
(vérins, convoyeurs, carton), y compris un vérin bloqué et le redémarrage après acquittement.
