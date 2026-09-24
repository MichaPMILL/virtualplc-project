import type { IconName } from '../icons.ts';
import type { MonitorSource } from '../actions.ts';

/** An editor shown in the work area. */
export interface EditorView {
  element: HTMLElement;
  title(): string;
  crumbs(): string[];
  icon: IconName;
  /** What "Visualiser tout" reads while this editor is active */
  monitor?: MonitorSource;
  /** Called when the project changed outside of the editor */
  refresh?(): void;
  /** Called when monitoring stops */
  monitorStopped?(): void;
  shown?(): void;
  destroy?(): void;
}
