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
- **Découvrir** envoie un ping sur une plage IPv4 (1–254) et lit la table ARP locale. Les voisins IPv6 sont ensuite lus dans la table des voisins du système (voir [IPv6](#ipv6)) et proposés, décochés, dans la liste.
- **Supervision** : chaque nœud est sondé (ping ICMP, ou connexion TCP si un port est défini). L’intervalle par défaut est de 5 s (`settings.probeIntervalMs`). L’état reste `unknown` jusqu’à deux résultats concordants (`settings.confirmations`) ; un seul échec ne bascule pas le nœud. Au plus une vingtaine de sondes tournent en parallèle. L’historique court est écrit à part dans `status.json`.
- **Lien actif / secours** : si un nœud a un lien `primary` et un lien `failover`, le lien actif est le primaire tant que le voisin primaire répond ; sinon le secours si son voisin répond ; sinon le primaire (en panne). Seul le lien actif est animé. Le secours reste visible, en attente, tant que le primaire répond.
- Clic droit sur un nœud pour ouvrir une session SSH dans le panneau latéral. Mot de passe et clé privée sont pris en charge (clés OpenSSH et fichiers PuTTY `.ppk`).
- **Clés d’hôte SSH (TOFU)** : à la première connexion à un `hôte:port`, la connexion est refusée tant que l’utilisateur n’a pas confirmé l’empreinte SHA256 de la clé présentée par le serveur. Après confirmation, la clé est mémorisée. Si un hôte connu présente une autre clé, la connexion est refusée (attaque de l’homme du milieu possible, ou serveur réinstallé) ; la boîte de dialogue d’erreur propose d’oublier la clé enregistrée, et la connexion suivante redemande une confirmation.
- Import et export de la topologie en JSON. Un export **ne contient aucun** mot de passe ni passphrase de clé. Il indique seulement, sur chaque nœud, si un secret existe et s’il s’agit d’un mot de passe ou d’une passphrase (`sshSecret.type`).

## Où est stockée la topologie

Si vous avez déjà utilisé la build Electron, l’application continue d’utiliser ce fichier :

- Linux : `~/.config/custom-network-topology/config.json`
- macOS : `~/Library/Application Support/custom-network-topology/config.json`
- Windows : `%APPDATA%\custom-network-topology\config.json`

Une installation neuve utilise le répertoire de config Tauri pour `com.custom.network-topology`. Au premier lancement, `renderer/config.json` y est copié.

Les mots de passe SSH et les passphrases de clé **ne sont pas** écrits dans ce fichier. Chacun est stocké dans le **trousseau du système** (service `custom-network-topology`, compte du type `ssh/<id du nœud>/password` ou `ssh/<id du nœud>/passphrase`). Le fichier de topologie ne conserve que `sshSecret.type` (`password` ou `passphrase`) lorsqu’un secret existe. Si le trousseau est indisponible, l’enregistrement d’un mot de passe est refusé : il n’est pas écrit en clair. Un mot de passe déjà scellé en `enc:v1:` est déplacé vers le trousseau au prochain chargement réussi. Une valeur écrite par le safe storage d’Electron ne peut pas être déchiffrée ; le fichier reste inchangé et l’application le signale.

Les clés d’hôte SSH acceptées sont dans `known_hosts.json`, dans le même dossier que le fichier de topologie. Chaque entrée `hôte:port` contient l’algorithme, l’empreinte SHA256 et la clé publique complète. Pour une adresse IPv6, la clé est `[adresse]:port` (par exemple `[2001:db8::1]:22`), avec l’adresse sous sa forme canonique compressée en minuscules ; les entrées IPv4 et nom d’hôte existantes gardent leur format. Ce fichier ne contient aucun secret.

## IPv6

- **Adresse d’un nœud** : une IPv4, un nom d’hôte, ou une IPv6 littérale — complète (`2001:db8:0:0:0:0:0:1`), compressée (`2001:db8::1`, `::1`) ou avec IPv4 embarquée (`::ffff:192.0.2.1`). Une zone (`fe80::1%eth0`, `fe80::1%12` sous Windows) n’est acceptée que sur une adresse lien-local (`fe80::/10`). La forme entre crochets `[::1]` est acceptée à la saisie et enregistrée sans crochets. Les mêmes règles sont appliquées dans la fenêtre (`renderer/js/hosts.js`) et dans le backend (`src-tauri/src/hosts.rs`) ; aucune valeur ne passe par un shell, et espaces, métacaractères et `-` initial restent refusés.
- **Ping** : une cible IPv6 utilise `ping -6` sous Linux et Windows, `ping6` sous macOS et BSD. Un nom d’hôte garde le `ping` par défaut du système.
- **Sonde TCP et SSH** : la connexion se fait vers le couple (hôte, port), jamais vers une chaîne `hôte:port` ambiguë. Une adresse lien-local avec zone passe par le résolveur du système.
- **Interfaces locales** : `network_local_info` renvoie d’abord les entrées IPv4 (champs inchangés), puis les adresses IPv6 avec `family: "IPv6"`, `prefix` et `scope` (`link` ou `global`). Le formulaire de découverte n’utilise que les entrées IPv4.
- **Voisins IPv6** : `network_neighbors` lit `ip -6 neigh show` (Linux), `ndp -an` (macOS, BSD) ou `netsh interface ipv6 show neighbors` (Windows). Les entrées incomplètes, en échec, injoignables ou multicast sont ignorées ; une adresse lien-local reçoit la zone de son interface.

## Structure du projet

```
Custom-network-topology/
├── src-tauri/              # Commandes Tauri : config, SSH, ping, scan, sondes, secrets
├── tailwind.config.js      # Fichiers scannés par Tailwind (renderer/**/*.html, renderer/js/**/*.js)
├── tailwind.css            # Entrée Tailwind (base, components, utilities)
├── lib/hosts.js            # Réexporte renderer/js/hosts.js pour les tests Node
├── renderer/
│   ├── index.html          # Fenêtre topologie
│   ├── admin.html          # Éditeur de nœuds (même document)
│   ├── config.json         # Exemple copié au premier lancement
│   └── js/
│       ├── desktop.js      # window.desktopAPI branché sur Tauri
│       ├── topology.js     # Document de topologie partagé
│       ├── hosts.js        # Contrôles hôte (IPv4, IPv6, nom) / port / plage, miroir de hosts.rs
│       ├── probe.js        # Confirmation d’état et lien actif
│       ├── canvas.js       # Géométrie du canevas (grille, zoom, liens, mini-carte)
│       ├── admin.js        # Tableau Admin
│       └── app.js          # Canevas, SSH, découverte, UI de supervision
├── scripts/
│   ├── copy-vendor.js      # Copie xterm et Lucide, compile Tailwind dans renderer/vendor
│   └── dev-server.js       # Sert renderer/ sur 127.0.0.1:1420
└── test/                   # hosts, topology, probe, secrets, config
```

`renderer/vendor/` est généré par `npm install` (script `postinstall`), puis régénéré avant `tauri dev` et `tauri build` (`beforeDevCommand` / `beforeBuildCommand`). Il n’est pas versionné. Tailwind ne génère que les classes présentes en toutes lettres dans `renderer/` : une classe construite par concaténation dans le JS doit être ajoutée au `safelist` de `tailwind.config.js`. Après une modification de classes hors `npm start`, relancer `node scripts/copy-vendor.js`.

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

`address` est une IPv4, une IPv6 ou un nom d’hôte. Un `port` numérique fait utiliser le TCP au lieu du ping. Les positions sont des pourcentages. Un câble est un `link` (`primary` ou `failover`) entre deux ports de nœuds. Les anciens `primaryParentId` / `secondaryParentId`, et l’ancien tableau `connections`, deviennent des `links` au premier chargement. Conteneurs et zones VLAN restent sur leurs nœuds. Les réglages SSH d’un nœud sont le port, l’utilisateur, le mode d’auth (`password` ou `key`), et le chemin de clé optionnel. Un secret enregistré n’apparaît que comme `sshSecret: { "type": "password" }` ou `"passphrase"`. Le secret lui-même n’est pas dans ce document.

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

- Le balayage de plage de la découverte reste IPv4 (base `a.b.c`, 1–254) : balayer un sous-réseau IPv6 (2^64 adresses) n’est pas faisable. En IPv6, la découverte ne voit que les hôtes déjà présents dans la table des voisins du système (ceux avec lesquels la machine a récemment échangé) ; l’ARP reste IPv4.
- Un nom d’hôte qui ne se résout qu’en IPv6 (AAAA seul) est pingé avec le `ping` par défaut ; sous macOS, ce `ping` est IPv4 seul et le nœud apparaît hors ligne. Saisissez l’adresse IPv6, ou définissez un port pour une sonde TCP.
- Le support IPv6 du ping, des sondes, du SSH et des tables de voisins n’est testé que par l’analyse des arguments et des sorties de commandes, pas sur un vrai réseau IPv6.
- Le canevas n’est testé que par sa géométrie. Le rendu DOM/SVG réel, les événements souris (glisser, déposer dans un conteneur, création de lien) et l’aspect visuel ne sont pas testés automatiquement.

## Licence

MIT. Voir [LICENSE](LICENSE).
