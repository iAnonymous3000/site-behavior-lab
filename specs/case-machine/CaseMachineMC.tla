--------------------------- MODULE CaseMachineMC ---------------------------
(***************************************************************************)
(* The plans the configurations beside this module name. Each is a plan    *)
(* the exploration suite walks: the full promised plan of register row     *)
(* F5-M, and the four smaller plans of row F5-S.                           *)
(***************************************************************************)
EXTENDS CaseMachine

PlanSixSlots == <<"B1", "B2", "B3", "I1", "I2", "I3">>
PlanInstrumented == <<"I1", "I2", "I3">>
PlanBaseline == <<"B1", "B2", "B3">>
PlanOneEach == <<"B1", "I1">>
PlanTwoEach == <<"B1", "B2", "I1", "I2">>

=============================================================================
