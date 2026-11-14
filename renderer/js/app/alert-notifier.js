// Desktop notifications for confirmed state changes.
//
// monitoring.js calls observe() with every monitor report and reset() when
// monitoring starts. The decisions live in alerts.js; this file only keeps the
// timer and hands notifications to the main process (tauri-plugin-notification).

import { Alerts } from './libs.js';

let state = Alerts.createState();
let settings = {};
let timer = null;

function schedule() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  const due = Alerts.nextDue(state, settings);
  if (due === null) return;
  timer = setTimeout(fire, Math.max(0, due - Date.now()));
}

function fire() {
  timer = null;
  Alerts.flush(state, Date.now(), settings).forEach(send);
  schedule();
}

function send(notification) {
  const api = window.desktopAPI && window.desktopAPI.alerts;
  if (!api) return;
  Promise.resolve(api.notify(notification.title, notification.body)).catch((error) => {
    console.warn('Notification failed:', error);
  });
}

function observe(nodes, nextSettings) {
  settings = nextSettings || {};
  Alerts.observe(state, nodes, Date.now(), settings);
  schedule();
}

function reset() {
  if (timer) clearTimeout(timer);
  timer = null;
  state = Alerts.createState();
}

export const AlertNotifier = { observe: observe, reset: reset };
