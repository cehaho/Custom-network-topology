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
- **Recherche** (`Ctrl+F` / `Cmd+F`) : le champ de la barre d’outils filtre les nœuds par nom, adresse (IPv4 ou IPv6, partielle), type, zone ou statut, sans tenir compte de la casse. Filtres : `status:down` (`up`, `down`, `unknown`), `vlan:10` (exact), `zone:dmz`, `type:server` (icône ou type de conteneur), `ip:10.0.`, `name:"core switch"` ; plusieurs valeurs séparées par des virgules (`status:down,unknown`), `-` pour exclure (`-type:docker`), les termes se cumulent. Les nœuds trouvés sont surlignés, les autres estompés, ainsi que les liens entre deux nœuds estompés. `Entrée` / flèches passent d’un résultat à l’autre et centrent la vue (compteur `n / m`) ; `Échap` efface la recherche. La logique est dans `renderer/js/search.js`.
- **Admin** édite le **même document** de topologie que le canevas, dans la même fenêtre. Une sauvegarde conserve les liens, ports, conteneurs et zones VLAN.
- **Découvrir** envoie un ping sur une plage IPv4 (1–254) et lit la table ARP locale. Les voisins IPv6 sont ensuite lus dans la table des voisins du système (voir [IPv6](#ipv6)) et proposés, décochés, dans la liste. Après le balayage, chaque hôte est enrichi sans ralentir le scan (`network_enrich`) : nom DNS inverse (PTR) via le résolveur du système (16 requêtes en parallèle au plus, 1,5 s maximum chacune) et fabricant déduit de l’adresse MAC (OUI). Une MAC administrée localement (bit `0x02` du premier octet, adresses Wi-Fi aléatoires) est affichée `Private/random`. La liste propose un nom de nœud (nom PTR court, sinon fabricant + dernier octet), modifiable, et une icône devinée du nom ou du fabricant. **Add Selected to Canvas** crée les nœuds (nom, adresse, `mac`, icône) en ignorant les adresses déjà présentes, les place en grille autour du centre de la vue, puis enregistre le document. La table OUI (`src-tauri/data/oui.txt`, ~550 Ko) provient du registre public IEEE MA-L (copie `manuf` de Wireshark, colonne du nom IEEE) ; on la régénère avec `node scripts/build-oui.js <oui.csv|manuf>`.
- **Supervision** : chaque nœud est sondé (ping ICMP, ou connexion TCP si un port est défini). L’intervalle par défaut est de 5 s (`settings.probeIntervalMs`). L’état reste `unknown` jusqu’à deux résultats concordants (`settings.confirmations`) ; un seul échec ne bascule pas le nœud. Au plus une vingtaine de sondes tournent en parallèle. L’historique court est écrit à part dans `status.json`.
  - **Sondes enrichies** (facultatif, champ `probe` du nœud, éditable dans Admin sous « Checks ») : quand `probe` est présent, il remplace le ping / port par défaut ; le nœud est `up` seulement si **toutes** les vérifications passent. Un nœud sans `probe` garde exactement le comportement précédent. Format :
    ```json
    "probe": {
      "ping": true,
      "tcp":  { "ports": [22, 443], "mode": "all" },
      "http": { "scheme": "https", "port": 8443, "path": "/health", "expectStatus": "200-399", "timeoutMs": 3000, "insecureTls": false },
      "dns":  { "name": "example.com", "type": "A", "port": 53, "timeoutMs": 2000 }
    }
    ```
    `tcp.mode` vaut `all` (tous les ports doivent répondre, au plus 16) ou `any` (un seul suffit). L’URL HTTP est construite à partir de l’adresse du nœud (aucun champ `host` ni `url` : un fichier importé ne peut pas viser un autre hôte), les redirections ne sont pas suivies, le statut attendu est `200-399` par défaut. `insecureTls` (HTTPS seulement, désactivé par défaut) accepte un certificat auto-signé. Le contrôle DNS envoie une requête A ou AAAA en UDP au nœud, considéré comme serveur DNS ; il réussit si une réponse contient au moins un enregistrement. Le résultat indique la vérification en échec dans un court `detail` (ex. `http 503 (expected 200-399)`, `tcp 443 closed`, `dns: NXDOMAIN`), affiché en infobulle sur l’état du nœud. Les mêmes règles sont validées dans `renderer/js/probe-checks.js` et `src-tauri/src/probe_kinds.rs` (cas partagés dans `test/fixtures/probe-checks.json`) ; un `probe` invalide fait refuser le document. HTTPS passe par `reqwest` avec rustls (aucune dépendance OpenSSL). Une adresse IPv6 lien-local avec zone n’est pas prise en charge pour HTTP.
- **Latence et disponibilité** : chaque sonde mesure un temps aller-retour. Pour le ping, il est lu sur la ligne de réponse (`time=12.3 ms` sous Linux et macOS, `time=12ms`, `time<1ms`, `temps=12 ms` ou `temps<1ms` sous Windows en anglais ou en français ; `<1ms` compte pour 0,5 ms) ; pour TCP, c’est la durée de la connexion. L’événement `monitor-status` garde ses champs (`status`, `responseTime`, `history`) et ajoute `reachable` (résultat brut de cette sonde, avant confirmation) et `rtt` (ms, `null` en cas d’échec). La fenêtre garde les 120 derniers résultats par nœud (`renderer/js/history.js`, amorcés depuis `status.json`). Au survol d’un nœud ou de sa ligne dans la liste des hôtes, une infobulle affiche la latence actuelle, min / moy / max, le taux de disponibilité et une courbe (interrompue à chaque échec, marqué en rouge).
- **Alertes de changement d’état** : quand la supervision confirme qu’un nœud passe de `up` à `down` (ou l’inverse), une notification système est affichée (« <nœud> is down » / « is back up », avec l’adresse). Le premier état confirmé et les passages par `unknown` ne sont jamais signalés. Une bascule annulée en moins de 3 s est ignorée ; au plus une notification par nœud pendant le délai de `settings.alertCooldownMs` (60 s par défaut, 5 s à 1 h) — l’état final est signalé à la fin du délai s’il diffère du dernier annoncé. Si plus de 5 nœuds changent dans la même rafale, une seule notification de synthèse est affichée. Désactivable via `settings.alertsEnabled` ; les deux réglages sont dans l’en-tête de l’**Admin** (« Alerts », « Cooldown »). Un document sans ces champs reçoit les valeurs par défaut. La logique est dans `renderer/js/alerts.js` ; l’affichage passe par `tauri-plugin-notification` (commande `alerts_notify`).
- **Lien actif / secours** : si un nœud a un lien `primary` et un lien `failover`, le lien actif est le primaire tant que le voisin primaire répond ; sinon le secours si son voisin répond ; sinon le primaire (en panne). Seul le lien actif est animé. Le secours reste visible, en attente, tant que le primaire répond.
- Clic droit sur un nœud pour ouvrir une session SSH dans le panneau latéral. Mot de passe et clé privée sont pris en charge (clés OpenSSH et fichiers PuTTY `.ppk`).
- **Clés d’hôte SSH (TOFU)** : à la première connexion à un `hôte:port`, la connexion est refusée tant que l’utilisateur n’a pas confirmé l’empreinte SHA256 de la clé présentée par le serveur. Après confirmation, la clé est mémorisée. Si un hôte connu présente une autre clé, la connexion est refusée (attaque de l’homme du milieu possible, ou serveur réinstallé) ; la boîte de dialogue d’erreur propose d’oublier la clé enregistrée, et la connexion suivante redemande une confirmation.
- Import et export de la topologie en JSON. Un export **ne contient aucun** mot de passe ni passphrase de clé. Il indique seulement, sur chaque nœud, si un secret existe et s’il s’agit d’un mot de passe ou d’une passphrase (`sshSecret.type`).
- **Export image** (bouton *Image*) : PNG (échelle 1x ou 2x) ou SVG autonome, sur fond sombre ou clair. Le SVG contient nœuds, libellés, liens, conteneurs et zones VLAN, avec styles embarqués, sans script ni ressource externe ; les icônes Lucide et SVG sont recopiées après filtrage, une icône URL est remplacée par l’initiale du nœud. Le PNG est rastérisé depuis ce SVG. L’écriture passe par la commande `image_export` et la boîte « Enregistrer sous » du système : le contenu est vérifié (signature PNG, SVG sans contenu actif) et l’extension `.png` / `.svg` est imposée. La construction du SVG est dans `renderer/js/export.js`.

## Actions rapides (clic droit sur un nœud)

- **Copy Address** copie l’adresse du nœud (sans crochets) dans le presse-papiers (`navigator.clipboard`, avec repli `execCommand('copy')`).
- **Open Web UI** ouvre `http(s)://adresse[:port]/` dans le navigateur du système (`tauri-plugin-opener`). L’URL est reconstruite côté Rust (`src-tauri/src/actions.rs`) à partir de l’adresse validée : seuls `http` et `https` sont possibles, une IPv6 est mise entre crochets (zone écrite `%25zone`). Champs optionnels du nœud : `webUrlScheme` (`http`/`https`, sinon `https` pour les ports 443 et 8443, `http` ailleurs) et `webPort` (1–65535). La fenêtre n’a pas la permission générique `opener:*`.
- **Traceroute** lance `traceroute -n -m 30 -w 2 -q 3` (Linux ; `-6` pour une IPv6, repli sans `-n` puis `traceroute6` pour le traceroute GNU inetutils), `traceroute`/`traceroute6` (macOS, BSD) ou `tracert -d -h 30 -w 2000` (Windows, `-6` en IPv6). L’hôte passe par `normalize_host` et est un argument séparé, sans shell. Arrêt forcé après 30 s ; la sortie déjà lue est renvoyée. Les sauts sont analysés en `{hop, address, rtts}` (`*` → `null`, `<1 ms` → 1) et affichés dans une fenêtre.
- **Wake-on-LAN** (visible si le nœud a une `mac`) envoie un paquet magique UDP (6 × `0xFF` puis 16 × la MAC, 102 octets) sur le port 9, vers `255.255.255.255` ou l’adresse IPv4 `wolBroadcast` du nœud (par ex. `192.168.1.255`). La MAC est acceptée sous la forme `aa:bb:cc:dd:ee:ff`, `aa-bb-…`, `aabb.ccdd.eeff` ou `aabbccddeeff`, et enregistrée en `aa:bb:cc:dd:ee:ff` ; les adresses nulle, broadcast et multicast sont refusées. Un nœud ajouté depuis la découverte garde la MAC lue dans la table ARP.

Les champs `mac`, `wolBroadcast`, `webUrlScheme` et `webPort` sont optionnels et se règlent dans « Quick Actions » du formulaire de nœud. Une valeur invalide trouvée dans un fichier est ignorée au chargement (`topology.js` et `topology.rs`) ; les anciens fichiers se chargent sans changement.

## Où est stockée la topologie

Si vous avez déjà utilisé la build Electron, l’application continue d’utiliser ce fichier :

- Linux : `~/.config/custom-network-topology/config.json`
- macOS : `~/Library/Application Support/custom-network-topology/config.json`
- Windows : `%APPDATA%\custom-network-topology\config.json`

Une installation neuve utilise le répertoire de config Tauri pour `com.custom.network-topology`. Au premier lancement, `renderer/config.json` y est copié.

Les mots de passe SSH et les passphrases de clé **ne sont pas** écrits dans ce fichier. Chacun est stocké dans le **trousseau du système** (service `custom-network-topology`, compte du type `ssh/<id du nœud>/password` ou `ssh/<id du nœud>/passphrase`). Le fichier de topologie ne conserve que `sshSecret.type` (`password` ou `passphrase`) lorsqu’un secret existe. Si le trousseau est indisponible, l’enregistrement d’un mot de passe est refusé : il n’est pas écrit en clair. Un mot de passe déjà scellé en `enc:v1:` est déplacé vers le trousseau au prochain chargement réussi. Une valeur écrite par le safe storage d’Electron ne peut pas être déchiffrée ; le fichier reste inchangé et l’application le signale.

Les clés d’hôte SSH acceptées sont dans `known_hosts.json`, dans le même dossier que le fichier de topologie. Chaque entrée `hôte:port` contient l’algorithme, l’empreinte SHA256 et la clé publique complète. Pour une adresse IPv6, la clé est `[adresse]:port` (par exemple `[2001:db8::1]:22`), avec l’adresse sous sa forme canonique compressée en minuscules ; les entrées IPv4 et nom d’hôte existantes gardent leur format. Ce fichier ne contient aucun secret.

La section **SSH host keys** du panneau Admin liste ces entrées (hôte, port, algorithme, empreinte SHA256, date d’ajout), avec un filtre et un bouton **Forget** par ligne (après confirmation ; la connexion suivante redemande l’empreinte). Le bouton **Import from OpenSSH known_hosts…** ouvre un sélecteur placé sur `~/.ssh/known_hosts` et importe les lignes `hôte`, `[hôte]:port` et les listes séparées par des virgules, pour les clés `ssh-ed25519`, `ecdsa-sha2-*` et `ssh-rsa`. Sont ignorés et comptés : les entrées hachées (`|1|…`, le nom d’hôte n’est pas récupérable), les lignes `@cert-authority` / `@revoked`, et les lignes invalides ou d’un autre type ; les motifs à joker (`*`, `?`, `!`) sont écartés. Quand le fichier donne plusieurs clés pour un même `hôte:port`, seule la clé préférée par le client (ed25519, puis ECDSA, puis RSA) est retenue. Une clé déjà enregistrée et différente n’est jamais remplacée : elle est signalée comme conflit et reste inchangée.

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
│       ├── history.js      # Historique de latence par nœud (tampon, stats, courbe)
│       ├── latency-ui.js   # Infobulle de latence au survol
│       ├── canvas.js       # Géométrie du canevas (grille, zoom, liens, mini-carte)
│       ├── export.js       # Export image : SVG autonome, PNG, boîte d’options
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
