# Fermeuse de cartons (exemple de programmation orientée objet)

Un carton arrive sur le convoyeur d'entrée et s'arrête contre une **butée**. La machine plie
les **rabats latéraux**, puis les **rabats avant/arrière**, **presse** le carton pendant
l'**encollage**, puis efface la butée et évacue le carton.

| Fichier | Contenu |
|---|---|
| `Tags.scl` | entrées / sorties (`%I`, `%Q`) et compteur de production `%MD10` |
| `Cylinders.scl` | interface `"ICylinder"` et trois vérins qui l'implémentent |
| `Sequence.scl` | FB `"CartonCloser"` : marche/arrêt, arrêt d'urgence, défauts, séquence (`CASE`) |
| `PlantModel.scl` | modèle de la machine (vérins, convoyeurs, cartons) pour la démonstration |
| `Main.scl` | capteurs réels ou modèle, instances des vérins, DB d'instance `"Machine"`, OB cyclique |
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

## Simulation dans le Studio

1. Ouvrir `project/Fermeuse de cartons.vplcproj`, puis *En ligne > Démarrer la simulation*
   (⌘⇧X / Ctrl+Maj+X) et valider le chargement.
2. Dans le panneau *Simulation* : `S_PlantModel` = 1 (le modèle remplace les capteurs),
   `AU_Ok` = 1 et `BP_Stop` = 1 (contacts NF), puis un clic sur **Impulsion** de `BP_Reset`.
3. **Impulsion** sur `BP_Start` : la machine enchaîne les cartons (voyant `H_Running`,
   distributeurs `YV_…`, compteur `BoxCount` et `"Machine".Step` dans la table de visualisation).
4. `S_Jam` = 1 bloque le vérin des rabats latéraux : défaut après 2 s, `H_Fault` clignote.
   Remettre `S_Jam` à 0, **Impulsion** sur `BP_Reset`, puis `BP_Start`.
5. `BP_Stop` à 0 : arrêt en fin de cycle.

Le test `sdk/test/examples.test.ts` fait tourner le programme avec un modèle de la machine
(vérins, convoyeurs, carton), y compris un vérin bloqué et le redémarrage après acquittement.
