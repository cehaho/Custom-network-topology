// Persistence of the topology document: save (through the desktop bridge),
// interactive import, export. Loading at start-up is in main.js because it
// redraws the canvas.

import { AppDialog, Topology } from './libs.js';
import { state } from './state.js';
import { toastError } from './ui.js';

let pendingImportToken = null;

export async function saveConfig() {
  const prepared = Topology.prepare(state.config);
  if (!prepared.ok) {
    console.error(prepared.error);
    return { success: false, error: prepared.error };
  }
  const snapshot = prepared.document;
  try {
    if (!window.desktopAPI) {
      state.config = snapshot;
      if (Topology.hasSecretValues(snapshot)) {
        (state.config.nodes || []).forEach((node) => Topology.stripNodeSecretValues(node));
        return {
          success: false,
          error: 'The system keyring is unavailable. The password was not saved.'
        };
      }
      return { success: true };
    }
    const result = await window.desktopAPI.config.save(snapshot, pendingImportToken);
    if (result && result.success !== false && result.config) {
      const loaded = Topology.read(result.config);
      state.config = loaded.ok ? loaded.document : Topology.withoutSecretValues(snapshot);
      pendingImportToken = null;
      return result;
    }
    state.config = snapshot;
    (state.config.nodes || []).forEach((node) => Topology.stripNodeSecretValues(node));
    return result || { success: false, error: 'Save failed' };
  } catch (error) {
    console.error('Failed to save config:', error);
    state.config = snapshot;
    (state.config.nodes || []).forEach((node) => Topology.stripNodeSecretValues(node));
    return { success: false, error: error && error.message ? error.message : 'Save failed' };
  }
}

export async function importTopologyInteractive() {
  if (!window.desktopAPI) return null;
  const result = await window.desktopAPI.config.import();
  if (!result || result.canceled) return null;
  if (!result.success || !result.config) {
    toastError('Import refused', (result && result.error) || 'Import failed');
    return null;
  }
  const loaded = Topology.read(result.config);
  if (!loaded.ok) {
    toastError('Import refused', loaded.error);
    return null;
  }
  if (!(await AppDialog.confirm(Topology.importMessage(loaded.document)))) {
    pendingImportToken = null;
    if (window.desktopAPI.config.discardImport) await window.desktopAPI.config.discardImport();
    return null;
  }
  pendingImportToken = result.importToken || null;
  return loaded.document;
}

export async function exportConfig() {
  if (!window.desktopAPI) return;
  const prepared = Topology.prepare(state.config);
  if (!prepared.ok) {
    toastError('Export refused', prepared.error);
    return;
  }
  const exported = Topology.withoutSecretValues(prepared.document);
  const result = await window.desktopAPI.config.export(exported);
  if (result && result.success === false && !result.canceled) {
    toastError('Export refused', result.error || 'Export failed');
  }
}
