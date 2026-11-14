// The classic scripts loaded before the modules (see index.html) define
// these globals. They stay plain scripts so the tests can require() them;
// importing them from here keeps every module's dependencies explicit.

const g = globalThis;

export const Topology = g.Topology;
export const Hosts = g.Hosts;
export const Probe = g.Probe;
export const Alerts = g.Alerts;
export const TopologyCanvas = g.TopologyCanvas;
export const NodeSearch = g.NodeSearch;
export const TopologyExport = g.TopologyExport;
export const Discovery = g.Discovery;
export const SnmpUI = g.SnmpUI;
export const QuickActions = g.QuickActions;
export const Admin = g.Admin;
export const LatencyHistory = g.LatencyHistory;
export const AppDialog = g.AppDialog;
export const lucide = g.lucide;
export const Terminal = g.Terminal;
export const FitAddon = g.FitAddon;
