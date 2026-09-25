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
  {
    name: 'VPLC_Cylinder', category: 'Actionneurs',
    description: 'Vérin pneumatique simple ou double effet : fins de course, surveillance du temps de manœuvre, modes automatique et manuel, défaut et acquittement',
    source: `FUNCTION_BLOCK "VPLC_Cylinder"
   VAR_INPUT
      Auto : Bool := TRUE;            // TRUE : commandé par la séquence (CmdWork / CmdHome)
      CmdWork : Bool;                 // automatique : aller en position travail
      CmdHome : Bool;                 // automatique : aller en position repos
      ManWork : Bool;                 // manuel : bouton « sortir » (front montant)
      ManHome : Bool;                 // manuel : bouton « rentrer » (front montant)
      Enable : Bool := TRUE;          // verrouillage : FALSE = aucun mouvement (sécurité, pression)
      WorkSensor : Bool;              // fin de course travail (sorti)
      HomeSensor : Bool;              // fin de course repos (rentré)
      UseWorkSensor : Bool := TRUE;   // FALSE : position travail estimée après NoSensorTime
      UseHomeSensor : Bool := TRUE;
      DoubleActing : Bool := TRUE;    // TRUE : deux bobines (distributeur bistable) ; FALSE : une bobine, retour ressort
      TravelTime : Time := T#3S;      // temps de manœuvre maximal
      NoSensorTime : Time := T#1S;    // temps de manœuvre supposé sans capteur
      Reset : Bool;                   // acquittement du défaut
   END_VAR
   VAR_OUTPUT
      CoilWork : Bool;                // bobine « sortir »
      CoilHome : Bool;                // bobine « rentrer » (double effet)
      AtWork : Bool;
      AtHome : Bool;
      Moving : Bool;
      Fault : Bool;
      FaultCode : Int;                // 1 : pas en travail à temps, 2 : pas au repos à temps, 3 : deux capteurs actifs
   END_VAR
   VAR
      TargetWork : Bool;
      EdgeWork : R_TRIG;
      EdgeHome : R_TRIG;
      Travel : TON;
      GuessWork : TON;
      GuessHome : TON;
   END_VAR
BEGIN
    EdgeWork(CLK := ManWork);
    EdgeHome(CLK := ManHome);
    IF Auto THEN
        IF CmdWork AND NOT CmdHome THEN
            TargetWork := TRUE;
        ELSIF CmdHome AND NOT CmdWork THEN
            TargetWork := FALSE;
        END_IF;
    ELSE
        IF EdgeWork.Q THEN
            TargetWork := TRUE;
        ELSIF EdgeHome.Q THEN
            TargetWork := FALSE;
        END_IF;
    END_IF;
    IF Reset THEN
        Fault := FALSE;
        FaultCode := 0;
    END_IF;
    // positions (estimated after NoSensorTime when a sensor is missing)
    GuessWork(IN := TargetWork AND Enable AND NOT Fault, PT := NoSensorTime);
    GuessHome(IN := NOT TargetWork AND Enable AND NOT Fault, PT := NoSensorTime);
    IF UseWorkSensor THEN
        AtWork := WorkSensor AND NOT (UseHomeSensor AND HomeSensor);
    ELSE
        AtWork := GuessWork.Q;
    END_IF;
    IF UseHomeSensor THEN
        AtHome := HomeSensor AND NOT (UseWorkSensor AND WorkSensor);
    ELSE
        AtHome := GuessHome.Q OR (NOT TargetWork AND NOT Enable AND NOT DoubleActing);
    END_IF;
    IF UseWorkSensor AND UseHomeSensor AND WorkSensor AND HomeSensor THEN
        Fault := TRUE;
        FaultCode := 3;
    END_IF;
    // coils
    CoilWork := TargetWork AND Enable AND NOT Fault;
    CoilHome := DoubleActing AND NOT TargetWork AND Enable AND NOT Fault;
    Moving := Enable AND NOT Fault AND ((TargetWork AND NOT AtWork) OR (NOT TargetWork AND NOT AtHome));
    // travel time monitoring
    Travel(IN := Moving, PT := TravelTime);
    IF Travel.Q THEN
        Fault := TRUE;
        IF TargetWork THEN
            FaultCode := 1;
        ELSE
            FaultCode := 2;
        END_IF;
        CoilWork := FALSE;
        CoilHome := FALSE;
    END_IF;
END_FUNCTION_BLOCK
`,
  },
  {
    name: 'VPLC_Sequencer', category: 'Séquences',
    description: 'Séquenceur d’étapes : modes manuel, automatique, cycle par cycle et pas à pas (validation de chaque étape), arrêt en fin de cycle, surveillance du temps d’étape',
    source: `FUNCTION_BLOCK "VPLC_Sequencer"
   // Usage : le programme calcule la transition de l'étape en cours (Step), puis appelle le bloc :
   //   CASE Seq.Step OF 1 : T := Cyl1.AtWork; 2 : T := Cyl2.AtHome; ... END_CASE;
   //   Seq(Mode := ..., Start := ..., Transition := T, LastStep := 5);
   VAR_INPUT
      Mode : Int := 1;                // 0 : manuel (séquence suspendue), 1 : automatique, 2 : cycle par cycle, 3 : pas à pas
      Start : Bool;                   // départ cycle (front montant)
      Stop : Bool;                    // arrêt en fin de cycle (front montant)
      StepPulse : Bool;               // pas à pas : validation de l'étape suivante (front montant)
      Transition : Bool;              // condition de fin de l'étape en cours
      LastStep : Int := 1;            // dernière étape du cycle
      Hold : Bool;                    // défaut / arrêt d'urgence : la séquence est figée
      Reset : Bool;                   // retour à l'étape initiale (0)
      StepTimeout : Time := T#0MS;    // 0 : pas de surveillance
   END_VAR
   VAR_OUTPUT
      Step : Int;                     // étape en cours (0 = initiale)
      Running : Bool;                 // cycle en cours
      NewStep : Bool;                 // TRUE pendant le premier cycle automate d'une étape
      CycleEnd : Bool;                // impulsion en fin de cycle
      WaitingValidation : Bool;       // pas à pas : transition vraie, en attente de StepPulse
      StopRequested : Bool;
      Timeout : Bool;                 // étape trop longue
      StepTime : Time;                // temps passé dans l'étape
   END_VAR
   VAR
      EdgeStart : R_TRIG;
      EdgeStop : R_TRIG;
      EdgePulse : R_TRIG;
      StepTimer : TON;
      Watchdog : TON;
      LastSeen : Int := -1;
   END_VAR
BEGIN
    EdgeStart(CLK := Start);
    EdgeStop(CLK := Stop);
    EdgePulse(CLK := StepPulse);
    CycleEnd := FALSE;
    IF Reset THEN
        Step := 0;
        Running := FALSE;
        StopRequested := FALSE;
        Timeout := FALSE;
    END_IF;
    IF EdgeStop.Q AND Running THEN
        StopRequested := TRUE;
    END_IF;
    WaitingValidation := FALSE;
    IF Mode = 0 THEN
        Running := FALSE;             // manuel : on commande les actionneurs à la main
    ELSIF NOT Hold AND NOT Reset THEN
        IF Step = 0 THEN
            IF EdgeStart.Q THEN
                Running := TRUE;
                StopRequested := FALSE;
                Step := 1;
            END_IF;
        ELSIF Transition AND (Running OR Mode = 3) THEN
            IF Mode = 3 AND NOT EdgePulse.Q THEN
                WaitingValidation := TRUE;
            ELSIF Step >= LastStep THEN
                CycleEnd := TRUE;
                IF Mode = 1 AND NOT StopRequested THEN
                    Step := 1;        // automatique : cycle suivant
                ELSE
                    Step := 0;        // cycle par cycle, pas à pas ou arrêt demandé
                    Running := FALSE;
                    StopRequested := FALSE;
                END_IF;
            ELSE
                Step := Step + 1;
            END_IF;
        ELSIF Step > 0 AND EdgeStart.Q THEN
            Running := TRUE;          // reprise après un arrêt (manuel, maintien)
        END_IF;
    END_IF;
    NewStep := Step <> LastSeen;
    LastSeen := Step;
    // time in the step (the timers restart at each new step)
    StepTimer(IN := NOT NewStep AND Step > 0, PT := T#24D);
    StepTime := StepTimer.ET;
    Watchdog(IN := NOT NewStep AND Step > 0 AND StepTimeout > T#0MS AND NOT Transition, PT := StepTimeout);
    IF Watchdog.Q THEN
        Timeout := TRUE;
    END_IF;
END_FUNCTION_BLOCK
`,
  },
  {
    name: 'VPLC_VisionTrigger', category: 'Vision / caméras',
    description: 'Déclenchement d’une caméra ou d’un capteur de vision (Keyence, Cognex, SICK, Omron…) et lecture du résultat OK / NG avec surveillance du temps',
    source: `FUNCTION_BLOCK "VPLC_VisionTrigger"
   // Poignée de main commune aux capteurs de vision, quelle que soit la liaison (EtherNet/IP,
   // PROFINET, IO-Link, E/S TOR) : relier les bits de l'appareil (voir son manuel / son EDS).
   VAR_INPUT
      Execute : Bool;                 // front montant : déclencher une inspection
      Ready : Bool := TRUE;           // bit « prêt » de la caméra (TRUE si l'appareil n'en a pas)
      Busy : Bool;                    // bit « occupé / acquisition en cours »
      ResultValid : Bool;             // bit « résultat disponible » (ou « fin d'inspection »)
      ResultOk : Bool;                // bit « OK » (total status)
      DeviceError : Bool;             // bit « erreur » de la caméra
      NeedsAck : Bool;                // TRUE : l'appareil attend un acquittement du résultat
      Timeout : Time := T#2S;         // durée maximale d'une inspection
      TriggerPulse : Time := T#50MS;  // durée minimale du bit de déclenchement
   END_VAR
   VAR_OUTPUT
      TriggerOut : Bool;              // vers le bit « trigger » de la caméra
      ResultAck : Bool;               // vers le bit « acquittement du résultat »
      Running : Bool;
      Done : Bool;                    // TRUE pendant un cycle : résultat lu
      Ok : Bool;                      // dernier résultat : bon
      Ng : Bool;                      // dernier résultat : mauvais
      Error : Bool;
      ErrorCode : Int;                // 1 : pas prête, 2 : temps dépassé, 3 : erreur de la caméra
      Count : DInt;                   // nombre d'inspections
      NgCount : DInt;
   END_VAR
   VAR
      Edge : R_TRIG;
      Pulse : TP;
      Watch : TON;
      Seen : Bool;                    // l'appareil a pris en compte le déclenchement
   END_VAR
BEGIN
    Edge(CLK := Execute);
    Done := FALSE;
    IF Edge.Q THEN
        IF NOT Ready THEN
            Error := TRUE;
            ErrorCode := 1;
        ELSE
            Running := TRUE;
            Error := FALSE;
            ErrorCode := 0;
            Seen := FALSE;
            Ok := FALSE;
            Ng := FALSE;
        END_IF;
    END_IF;
    Pulse(IN := Edge.Q AND Running, PT := TriggerPulse);
    TriggerOut := Pulse.Q OR (Running AND NOT Seen AND NOT ResultValid);
    IF Busy OR ResultValid THEN
        Seen := TRUE;
    END_IF;
    Watch(IN := Running, PT := Timeout);
    IF Running THEN
        IF DeviceError THEN
            Running := FALSE;
            Error := TRUE;
            ErrorCode := 3;
        ELSIF ResultValid AND NOT Busy AND NOT Pulse.Q THEN
            Running := FALSE;
            Done := TRUE;
            Ok := ResultOk;
            Ng := NOT ResultOk;
            Count := Count + 1;
            IF NOT ResultOk THEN
                NgCount := NgCount + 1;
            END_IF;
        ELSIF Watch.Q THEN
            Running := FALSE;
            Error := TRUE;
            ErrorCode := 2;
        END_IF;
    END_IF;
    IF NOT Running THEN
        TriggerOut := FALSE;
    END_IF;
    // acknowledgement of the result, kept until the device clears ResultValid
    ResultAck := NeedsAck AND ResultValid AND NOT Running;
END_FUNCTION_BLOCK
`,
  },
];
