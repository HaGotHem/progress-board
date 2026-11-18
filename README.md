# progress-board

Un mod pour Claude Code qui montre l'avancement de la session et de chaque agent.

- **Panneau Avancement** : une barre générale, une barre par tâche du plan, et une carte par agent avec un petit personnage pixel-art (Claude ou Gemini), un chapeau et un outil selon son rôle (vérification, recherche, création, architecte, orchestrateur, polyvalent), et son état (occupé, libre, échec).
- **Vue Bureau** (bouton « Vue bureau » ou `/progress bureau`) : chaque agent travaille à son bureau. Un nouvel agent arrive par la porte et reçoit son bureau, le chef de projet lui apporte sa tâche, et un agent qui a fini depuis un moment fait ses cartons et sort. La vue Bureau est dessinée en SVG : elle s'affiche dans l'app de bureau et dans VS Code, pas dans le terminal.
- Reconnaît les sous-agents Claude (Opus, Sonnet, Haiku, Fable) et les appels Gemini faits avec le wrapper `ask-gemini` ou `agy` (Flash, Hydrogen, Argon, d'après `--model` ou `--effort`).

Commandes : `/progress` ouvre le panneau, `/progress bureau` la vue Bureau, `/progress reset` vide le panneau.

## Installation

Dans un terminal Claude Code :

```
/plugin install progress-board --marketplace HaGotHem/progress-board
```

Répondez `y` pour ajouter la marketplace, puis choisissez une portée (user par défaut).

Depuis un shell :

```
claude plugin install progress-board --marketplace HaGotHem/progress-board
```

Dans l'app de bureau, où `/plugin` ne fonctionne pas : cliquez sur **+** à côté de la zone de saisie, puis **Plugins**, **Add marketplace** avec `HaGotHem/progress-board`, puis **Add plugin**.

Le dépôt est privé : l'installation ne marche que pour les personnes invitées sur GitHub, dont l'ordinateur a déjà un accès Git à github.com (une clé SSH, ou `gh auth login` puis `gh auth setup-git`).

## Développement

```
claude plugin validate .
claude plugin test .
```
