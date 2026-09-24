# Feux tricolores (exemple sans programmation orientée objet)

Carrefour entre une rue principale et une rue secondaire, avec un passage piétons sur la rue
principale.

- La rue principale reste au vert tant qu'il n'y a pas de demande ; la rue secondaire passe au
  vert sur **détection d'un véhicule** (`B_SideVehicle`) ou **appel piéton**
  (`BP_Pedestrian`, voyant « attendez » `H_Ped_Wait`), après le vert minimal de la rue
  principale.
- Orange, puis **tout rouge** de dégagement à chaque changement.
- Les piétons ont le vert au début du vert de la rue secondaire.
- **Orange clignotant** quand le commutateur `S_On` est sur arrêt, en **mode nuit**
  (`S_Night`) et pendant 5 s à la mise en service, puis tout rouge avant de démarrer.
- Durées réglables dans le DB `"Timings"` (depuis une table de visualisation ou un pupitre).

| Fichier | Contenu |
|---|---|
| `Tags.scl` | entrées / sorties, phase `%MW20`, compteur de cycles `%MD22` |
| `Timings.scl` | DB des durées |
| `Main.scl` | FB `"Crossroads"` (machine d'états `CASE` + `TON`), DB d'instance, OB cyclique |
| `project/` | le même programme en projet VirtualPLC Studio |

Le programme est testé dans `sdk/test/examples.test.ts` (séquence complète, appel piéton,
détection de véhicule, mode nuit).
