# Network Topology Manager

Application de bureau pour dessiner une topologie réseau, voir quels hôtes répondent, et ouvrir un terminal SSH sur un nœud. La fenêtre est une page statique. **Tauri** l’héberge et exécute le ping, l’ARP et le SSH (plus d’Electron).

Le schéma d’exemple comporte quatre hôtes : une passerelle, Internet (`8.8.8.8`), un NAS et un poste de travail. Votre topologie réelle est enregistrée hors du dépôt.

## Prérequis

- Node.js 18 ou plus récent
- npm
- Rust stable (1.90 ou plus) et Cargo
- Sous Linux : WebKitGTK 4.1 et les bibliothèques de développement GTK 3
- Une connexion réseau uniquement pour `npm install`. L’interface ne charge rien depuis Internet : xterm (`@xterm/xterm`, `@xterm/addon-fit`) et Lucide sont copiés depuis `node_modules`, et la feuille Tailwind est compilée localement.

Sous Debian / Ubuntu, les paquets WebKitGTK / GTK ressemblent souvent à :

```bash
sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev
```

Les noms exacts dépendent de la distribution. Sans WebKitGTK, `npm start` échoue à la compilation Tauri.

## Lancer

```bash
git clone https://github.com/cehaho/Custom-network-topology.git
cd Custom-network-topology
npm install
npm start
```

`npm start` et `npm run dev` lancent `tauri dev`. `npm run build` empaquete l’application pour le système d’exploitation en cours.

`npm test` exécute les tests JavaScript (`node --test`) et Rust (`cargo test` dans `src-tauri/`). Aucune fenêtre n’est ouverte.

## Ce que fait la fenêtre

- Déplacer les nœuds, panoramiquer le fond, zoomer à la molette.
- **Admin** édite le **même document** de topologie que le canevas, dans la même fenêtre. Une sauvegarde conserve les liens, ports, conteneurs et zones VLAN.
- **Découvrir** envoie un ping sur une plage IPv4 (1–254) et lit la table ARP locale.
- **Supervision** : chaque nœud est sondé (ping ICMP, ou connexion TCP si un port est défini). L’intervalle par défaut est de 5 s (`settings.probeIntervalMs`). L’état reste `unknown` jusqu’à deux résultats concordants (`settings.confirmations`) ; un seul échec ne bascule pas le nœud. Au plus une vingtaine de sondes tournent en parallèle. L’historique court est écrit à part dans `status.json`.
- **Lien actif / secours** : si un nœud a un lien `primary` et un lien `failover`, le lien actif est le primaire tant que le voisin primaire répond ; sinon le secours si son voisin répond ; sinon le primaire (en panne). Seul le lien actif est animé. Le secours reste visible, en attente, tant que le primaire répond.
- Clic droit sur un nœud pour ouvrir une session SSH dans le panneau latéral. Mot de passe et clé privée sont pris en charge (clés OpenSSH et fichiers PuTTY `.ppk`).
- Import et export de la topologie en JSON. Un export **ne contient aucun** mot de passe ni passphrase de clé. Il indique seulement, sur chaque nœud, si un secret existe et s’il s’agit d’un mot de passe ou d’une passphrase (`sshSecret.type`).

## Où est stockée la topologie

Si vous avez déjà utilisé la build Electron, l’application continue d’utiliser ce fichier :

- Linux : `~/.config/custom-network-topology/config.json`
- macOS : `~/Library/Application Support/custom-network-topology/config.json`
- Windows : `%APPDATA%\custom-network-topology\config.json`

Une installation neuve utilise le répertoire de config Tauri pour `com.custom.network-topology`. Au premier lancement, `renderer/config.json` y est copié.

Les mots de passe SSH et les passphrases de clé **ne sont pas** écrits dans ce fichier. Chacun est stocké dans le **trousseau du système** (service `custom-network-topology`, compte du type `ssh/<id du nœud>/password` ou `ssh/<id du nœud>/passphrase`). Le fichier de topologie ne conserve que `sshSecret.type` (`password` ou `passphrase`) lorsqu’un secret existe. Si le trousseau est indisponible, l’enregistrement d’un mot de passe est refusé : il n’est pas écrit en clair. Un mot de passe déjà scellé en `enc:v1:` est déplacé vers le trousseau au prochain chargement réussi. Une valeur écrite par le safe storage d’Electron ne peut pas être déchiffrée ; le fichier reste inchangé et l’application le signale.

## Structure du projet

```
Custom-network-topology/
├── src-tauri/              # Commandes Tauri : config, SSH, ping, scan, sondes, secrets
├── tailwind.config.js      # Fichiers scannés par Tailwind (renderer/**/*.html, renderer/js/**/*.js)
├── tailwind.css            # Entrée Tailwind (base, components, utilities)
├── lib/hosts.js            # Contrôles hôte / port / plage (mirroir Rust)
├── renderer/
│   ├── index.html          # Fenêtre topologie
│   ├── admin.html          # Éditeur de nœuds (même document)
│   ├── config.json         # Exemple copié au premier lancement
│   └── js/
│       ├── desktop.js      # window.electronAPI branché sur Tauri
│       ├── topology.js     # Document de topologie partagé
│       ├── probe.js        # Confirmation d’état et lien actif
│       ├── canvas.js       # Géométrie du canevas (grille, zoom, liens, mini-carte)
│       ├── admin.js        # Tableau Admin
│       └── app.js          # Canevas, SSH, découverte, UI de supervision
├── scripts/
│   ├── copy-vendor.js      # Copie xterm et Lucide, compile Tailwind dans renderer/vendor
│   └── dev-server.js       # Sert renderer/ sur 127.0.0.1:1420
└── test/                   # hosts, topology, probe, secrets, config
```

`renderer/vendor/` est généré par `npm install` (script `postinstall`), puis régénéré avant `tauri dev` et `tauri build` (`beforeDevCommand` / `beforeBuildCommand`). Il n’est pas versionné. Tailwind ne génère que les classes présentes en toutes lettres dans `renderer/` : une classe construite par concaténation dans le JS doit être ajoutée au `safelist` de `tailwind.config.js`. Après une modification de classes hors `npm start`, relancer `node scripts/copy-vendor.js`. Le nom `window.electronAPI` est conservé côté rendu pour limiter le diff ; l’implémentation est Tauri.

## Configuration

Le canevas et le tableau Admin lisent et écrivent **un seul** document :

```json
{
  "schemaVersion": 1,
  "settings": {
    "showGrid": true,
    "gridSize": 100,
    "snapToGrid": true,
    "theme": "dark",
    "probeIntervalMs": 5000,
    "confirmations": 2
  },
  "nodes": [
    {
      "id": "node_gateway",
      "name": "Gateway Router",
      "address": "192.168.1.1",
      "port": null,
      "icon": "router",
      "iconType": "lucide",
      "x": 50,
      "y": 85,
      "ports": [
        { "id": "node_gateway_in", "name": "IN", "side": "top" },
        { "id": "node_gateway_out", "name": "OUT", "side": "bottom" }
      ]
    }
  ],
  "links": [
    {
      "id": "link_node_internet_primary",
      "sourceNodeId": "node_gateway",
      "sourcePortId": "node_gateway_out",
      "targetNodeId": "node_internet",
      "targetPortId": "node_internet_in",
      "role": "primary",
      "medium": null,
      "speed": null
    }
  ],
  "ports": [
    { "id": "node_gateway_out", "name": "OUT", "side": "bottom", "nodeId": "node_gateway" }
  ]
}
```

`address` est une IPv4 ou un nom d’hôte. Un `port` numérique fait utiliser le TCP au lieu du ping. Les positions sont des pourcentages. Un câble est un `link` (`primary` ou `failover`) entre deux ports de nœuds. Les anciens `primaryParentId` / `secondaryParentId`, et l’ancien tableau `connections`, deviennent des `links` au premier chargement. Conteneurs et zones VLAN restent sur leurs nœuds. Les réglages SSH d’un nœud sont le port, l’utilisateur, le mode d’auth (`password` ou `key`), et le chemin de clé optionnel. Un secret enregistré n’apparaît que comme `sshSecret: { "type": "password" }` ou `"passphrase"`. Le secret lui-même n’est pas dans ce document.

Une sauvegarde est refusée si le JSON n’a pas de tableau `nodes` ni de `schemaVersion` supporté. Le nouveau fichier est écrit dans un temporaire du même dossier, puis renommé. Le fichier précédent est conservé en `config.json.bak`. L’import affiche le nombre de nœuds, de liens et la version, et demande confirmation avant de remplacer le document ouvert.

## Paquets

- `@tauri-apps/cli` lance et empaquete la fenêtre
- `xterm` et `xterm-addon-fit` dessinent le terminal
- Le SSH est implémenté en Rust avec `russh`, pas un paquet Node

## Vérifications

```bash
npm test
```

Couvre la validation des hôtes, le document de topologie, la confirmation de sonde / lien actif, et le traitement des secrets (côté JS et Rust selon les modules).

`test/canvas.test.js` couvre la géométrie du canevas, isolée dans `renderer/js/canvas.js` : magnétisme de la grille, zoom autour du curseur et pan, sélection rectangulaire, position des ports, tracé des liens (courbes de Bézier, étiquettes, style selon la sonde), mise en page automatique, et dessin de la mini-carte sur un contexte 2D factice qui enregistre les appels.

## Limites

- Découverte et supervision en IPv4 uniquement.
- Le SSH accepte la clé d’hôte du serveur sans la mémoriser. Pas de contrôle known-hosts dans cette version.
- Le canevas n’est testé que par sa géométrie. Le rendu DOM/SVG réel, les événements souris (glisser, déposer dans un conteneur, création de lien) et l’aspect visuel ne sont pas testés automatiquement.

## Licence

MIT. Voir [LICENSE](LICENSE).
