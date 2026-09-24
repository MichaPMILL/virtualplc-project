// VirtualPLC standard library: tested blocks for everyday automation (SCL sources).
// Shown in the Studio (task card "Bibliothèques"); inserting an element copies the block
// into the project, where it can be read and changed like any other block.
// The blocks are tested in sdk/test/stdlib.test.ts.

export interface StandardElement {
  name: string;
  category: string;
  description: string;
  source: string;
}

export const STANDARD_LIBRARY_NAME = 'Bibliothèque standard VirtualPLC';
export const STANDARD_LIBRARY_VERSION = '1.0.0';

export const STANDARD_LIBRARY: StandardElement[] = [
  {
    name: 'VPLC_Blink', category: 'Signaux', description: 'Clignoteur : durées haute et basse réglables',
    source: `FUNCTION_BLOCK "VPLC_Blink"
   VAR_INPUT
      Enable : Bool;
      TimeOn : Time := T#500MS;
      TimeOff : Time := T#500MS;
   END_VAR
   VAR_OUTPUT
      Q : Bool;
   END_VAR
   VAR
      Timer : TON;
   END_VAR
BEGIN
    IF NOT Enable THEN
        Q := FALSE;
        Timer(IN := FALSE);
        RETURN;
    END_IF;
    IF Q THEN
        Timer(IN := TRUE, PT := TimeOn);
    ELSE
        Timer(IN := TRUE, PT := TimeOff);
    END_IF;
    IF Timer.Q THEN
        Q := NOT Q;
        Timer(IN := FALSE);
    END_IF;
END_FUNCTION_BLOCK
`,
  },
  {
    name: 'VPLC_Debounce', category: 'Signaux', description: "Anti-rebond : la sortie suit l'entrée quand elle est stable pendant Delay",
    source: `FUNCTION_BLOCK "VPLC_Debounce"
   VAR_INPUT
      In : Bool;
      Delay : Time := T#20MS;
   END_VAR
   VAR_OUTPUT
      Q : Bool;
   END_VAR
   VAR
      Stable : TON;
   END_VAR
BEGIN
    Stable(IN := In <> Q, PT := Delay);
    IF Stable.Q THEN
        Q := In;
        Stable(IN := FALSE);
    END_IF;
END_FUNCTION_BLOCK
`,
  },
  {
    name: 'VPLC_Hysteresis', category: 'Régulation', description: 'Seuil à hystérésis (Q à TRUE au-dessus de OnLevel, à FALSE sous OffLevel)',
    source: `FUNCTION_BLOCK "VPLC_Hysteresis"
   VAR_INPUT
      Value : Real;
      OnLevel : Real;
      OffLevel : Real;
   END_VAR
   VAR_OUTPUT
      Q : Bool;
   END_VAR
BEGIN
    IF Value >= OnLevel THEN
        Q := TRUE;
    ELSIF Value <= OffLevel THEN
        Q := FALSE;
    END_IF;
END_FUNCTION_BLOCK
`,
  },
  {
    name: 'VPLC_Ramp', category: 'Régulation', description: 'Rampe : la sortie rejoint la consigne avec des pentes maximales (unités / s)',
    source: `FUNCTION_BLOCK "VPLC_Ramp"
   VAR_INPUT
      Setpoint : Real;
      RiseRate : Real := 10.0;    // unités par seconde
      FallRate : Real := 10.0;
      Reset : Bool;               // Out := Setpoint immédiatement
   END_VAR
   VAR_OUTPUT
      Out : Real;
      Done : Bool;                // Out = Setpoint
   END_VAR
   VAR
      Last : UDInt;
      Started : Bool;
   END_VAR
   VAR_TEMP
      now : UDInt;
      dtSec : Real;
   END_VAR
BEGIN
    now := MILLIS();
    dtSec := UDINT_TO_REAL(now - Last) / 1000.0;
    Last := now;
    IF Reset OR NOT Started THEN
        Started := TRUE;
        Out := Setpoint;
    ELSIF Out < Setpoint THEN
        Out := MIN(Out + RiseRate * dtSec, Setpoint);
    ELSIF Out > Setpoint THEN
        Out := MAX(Out - FallRate * dtSec, Setpoint);
    END_IF;
    Done := Out = Setpoint;
END_FUNCTION_BLOCK
`,
  },
  {
    name: 'VPLC_PID', category: 'Régulation', description: 'Régulateur PID (forme parallèle, anti-saturation, mode manuel sans à-coup)',
    source: `FUNCTION_BLOCK "VPLC_PID"
   VAR_INPUT
      Setpoint : Real;
      ProcessValue : Real;
      Kp : Real := 1.0;             // gain proportionnel
      Ti : Time := T#10S;           // temps d'intégration (T#0S = pas d'action intégrale)
      Td : Time := T#0S;            // temps de dérivation
      OutMin : Real := 0.0;
      OutMax : Real := 100.0;
      Manual : Bool;
      ManualValue : Real;
      Reverse : Bool;               // action inverse (ex. refroidissement)
   END_VAR
   VAR_OUTPUT
      Output : Real;
      Error : Real;
      Saturated : Bool;
   END_VAR
   VAR
      Integral : Real;
      LastPv : Real;
      Last : UDInt;
      Started : Bool;
   END_VAR
   VAR_TEMP
      now : UDInt;
      dtSec : Real;
      p : Real;
      d : Real;
      out : Real;
   END_VAR
BEGIN
    now := MILLIS();
    dtSec := UDINT_TO_REAL(now - Last) / 1000.0;
    Last := now;
    IF NOT Started THEN
        Started := TRUE;
        dtSec := 0.0;
        LastPv := ProcessValue;
    END_IF;
    Error := Setpoint - ProcessValue;
    IF Reverse THEN
        Error := -Error;
    END_IF;
    IF Manual THEN
        // sans à-coup : l'intégrale suit la sortie manuelle
        Output := LIMIT(OutMin, ManualValue, OutMax);
        Integral := Output - Kp * Error;
        LastPv := ProcessValue;
        Saturated := FALSE;
        RETURN;
    END_IF;
    p := Kp * Error;
    IF Ti > T#0S THEN
        Integral := Integral + Kp * Error * dtSec / (DINT_TO_REAL(TIME_TO_DINT(Ti)) / 1000.0);
    ELSE
        Integral := 0.0;
    END_IF;
    d := 0.0;
    IF Td > T#0S AND dtSec > 0.0 THEN
        d := -Kp * (DINT_TO_REAL(TIME_TO_DINT(Td)) / 1000.0) * (ProcessValue - LastPv) / dtSec;
        IF Reverse THEN
            d := -d;
        END_IF;
    END_IF;
    LastPv := ProcessValue;
    out := p + Integral + d;
    Saturated := out > OutMax OR out < OutMin;
    IF Saturated THEN
        // anti-saturation : l'intégrale est ramenée à ce qui reste dans les limites
        out := LIMIT(OutMin, out, OutMax);
        Integral := out - p - d;
    END_IF;
    Output := out;
END_FUNCTION_BLOCK
`,
  },
  {
    name: 'VPLC_Scale', category: 'Analogique', description: 'Mise à l’échelle d’une entrée analogique (0..27648 ou -27648..27648) en unités physiques',
    source: `FUNCTION "VPLC_Scale" : Real
   VAR_INPUT
      Raw : Int;           // valeur brute de la carte d'entrées (%IW)
      Low : Real;          // valeur physique à 0 (ou -27648 en bipolaire)
      High : Real;         // valeur physique à 27648
      Bipolar : Bool;
   END_VAR
   VAR_TEMP
      k : Real;
   END_VAR
BEGIN
    IF Bipolar THEN
        k := (INT_TO_REAL(Raw) + 27648.0) / 55296.0;
    ELSE
        k := INT_TO_REAL(Raw) / 27648.0;
    END_IF;
    "VPLC_Scale" := Low + k * (High - Low);
END_FUNCTION
`,
  },
  {
    name: 'VPLC_Unscale', category: 'Analogique', description: 'Valeur physique vers valeur brute d’une sortie analogique (0..27648 ou -27648..27648)',
    source: `FUNCTION "VPLC_Unscale" : Int
   VAR_INPUT
      Value : Real;
      Low : Real;
      High : Real;
      Bipolar : Bool;
   END_VAR
   VAR_TEMP
      k : Real;
   END_VAR
BEGIN
    IF High = Low THEN
        "VPLC_Unscale" := 0;
        RETURN;
    END_IF;
    k := LIMIT(0.0, (Value - Low) / (High - Low), 1.0);
    IF Bipolar THEN
        "VPLC_Unscale" := REAL_TO_INT(k * 55296.0 - 27648.0);
    ELSE
        "VPLC_Unscale" := REAL_TO_INT(k * 27648.0);
    END_IF;
END_FUNCTION
`,
  },
  {
    name: 'VPLC_MovingAverage', category: 'Analogique', description: 'Moyenne glissante sur 1 à 32 échantillons (un par appel)',
    source: `FUNCTION_BLOCK "VPLC_MovingAverage"
   VAR_INPUT
      Value : Real;
      Samples : Int := 10;
      Reset : Bool;
   END_VAR
   VAR_OUTPUT
      Average : Real;
   END_VAR
   VAR
      Buffer : Array[1..32] of Real;
      Index : Int;
      Count : Int;
      Sum : Real;
   END_VAR
   VAR_TEMP
      n : Int;
   END_VAR
BEGIN
    n := LIMIT(1, Samples, 32);
    IF Reset OR Count > n THEN
        Index := 0;
        Count := 0;
        Sum := 0.0;
    END_IF;
    Index := Index + 1;
    IF Index > n THEN
        Index := 1;
    END_IF;
    IF Count = n THEN
        Sum := Sum - Buffer[Index];
    ELSE
        Count := Count + 1;
    END_IF;
    Buffer[Index] := Value;
    Sum := Sum + Value;
    Average := Sum / INT_TO_REAL(Count);
END_FUNCTION_BLOCK
`,
  },
  {
    name: 'VPLC_OperatingHours', category: 'Maintenance', description: 'Compteur d’heures de fonctionnement et de démarrages',
    source: `FUNCTION_BLOCK "VPLC_OperatingHours"
   VAR_INPUT
      Running : Bool;
      Reset : Bool;
   END_VAR
   VAR_OUTPUT
      Hours : DInt;
      Minutes : Int;
      TotalSeconds : DInt;
      Starts : DInt;
   END_VAR
   VAR
      Ms : UDInt;
      Last : UDInt;
      WasRunning : Bool;
   END_VAR
   VAR_TEMP
      now : UDInt;
   END_VAR
BEGIN
    now := MILLIS();
    IF Reset THEN
        Ms := 0;
        TotalSeconds := 0;
        Starts := 0;
    END_IF;
    IF Running AND WasRunning THEN
        Ms := Ms + (now - Last);
        WHILE Ms >= 1000 DO
            Ms := Ms - 1000;
            TotalSeconds := TotalSeconds + 1;
        END_WHILE;
    END_IF;
    IF Running AND NOT WasRunning THEN
        Starts := Starts + 1;
    END_IF;
    WasRunning := Running;
    Last := now;
    Hours := TotalSeconds / 3600;
    Minutes := DINT_TO_INT((TotalSeconds MOD 3600) / 60);
END_FUNCTION_BLOCK
`,
  },
  {
    name: 'VPLC_Motor', category: 'Actionneurs', description: 'Moteur marche/arrêt : retour de marche surveillé, défaut thermique, acquittement',
    source: `FUNCTION_BLOCK "VPLC_Motor"
   VAR_INPUT
      Start : Bool;                   // demande de marche (front montant)
      Stop : Bool;                    // demande d'arrêt (TRUE = arrêter)
      Feedback : Bool;                // retour de marche du contacteur
      Trip : Bool;                    // défaut externe (relais thermique...)
      Reset : Bool;
      FeedbackTime : Time := T#2S;    // délai maximal du retour de marche
   END_VAR
   VAR_OUTPUT
      Run : Bool;                     // commande du contacteur
      Running : Bool;                 // marche confirmée
      Alarm : Bool;
      AlarmCode : Int;                // 1 = défaut externe, 2 = pas de retour de marche, 3 = retour de marche inattendu
   END_VAR
   VAR
      StartEdge : R_TRIG;
      Watch : TON;
   END_VAR
BEGIN
    StartEdge(CLK := Start);
    IF Reset AND NOT Trip THEN
        Alarm := FALSE;
        AlarmCode := 0;
    END_IF;
    IF Trip AND NOT Alarm THEN
        Alarm := TRUE;
        AlarmCode := 1;
    END_IF;
    IF StartEdge.Q AND NOT Alarm AND NOT Stop THEN
        Run := TRUE;
    END_IF;
    IF Stop OR Alarm THEN
        Run := FALSE;
    END_IF;
    Watch(IN := Run <> Feedback, PT := FeedbackTime);
    IF Watch.Q AND NOT Alarm THEN
        Alarm := TRUE;
        AlarmCode := SEL(G := Run, IN0 := 3, IN1 := 2);
        Run := FALSE;
    END_IF;
    Running := Run AND Feedback;
END_FUNCTION_BLOCK
`,
  },
  {
    name: 'VPLC_Valve', category: 'Actionneurs', description: 'Vanne tout-ou-rien avec fins de course et surveillance du temps de manœuvre',
    source: `FUNCTION_BLOCK "VPLC_Valve"
   VAR_INPUT
      Open : Bool;                    // commande : TRUE = ouvrir
      OpenedSwitch : Bool;            // fin de course ouvert
      ClosedSwitch : Bool;            // fin de course fermé
      Reset : Bool;
      TravelTime : Time := T#10S;
   END_VAR
   VAR_OUTPUT
      Output : Bool;                  // bobine / actionneur
      IsOpen : Bool;
      IsClosed : Bool;
      Alarm : Bool;
   END_VAR
   VAR
      Watch : TON;
   END_VAR
BEGIN
    IF Reset THEN
        Alarm := FALSE;
    END_IF;
    Output := Open AND NOT Alarm;
    IsOpen := OpenedSwitch AND NOT ClosedSwitch;
    IsClosed := ClosedSwitch AND NOT OpenedSwitch;
    Watch(IN := (Output AND NOT IsOpen) OR (NOT Output AND NOT IsClosed), PT := TravelTime);
    IF Watch.Q THEN
        Alarm := TRUE;
    END_IF;
END_FUNCTION_BLOCK
`,
  },
];
