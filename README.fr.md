# Orca-superagent (OSA)

**Plusieurs ordinateurs. Plusieurs agents. Un seul espace de collaboration.**

Confiez un objectif au Router et laissez les agents faire avancer le travail. Suivez la progression dans un panneau unique, accédez aux ordinateurs distants avec Orca et prenez les décisions essentielles.

[中文](README.md) · [English](README.en.md) · [Français](README.fr.md) · [Español](README.es.md) · [Русский](README.ru.md) · [العربية](README.ar.md)

## De Human to Human à Agent to Agent

| Collaboration | Comment le travail avance |
| --- | --- |
| **Human → Human** | Les personnes échangent, se répartissent le travail et passent le relais |
| **Human → Agent** | Une personne décrit un objectif ; un agent réalise la tâche |
| **Agent → Human** | Les agents rendent compte, posent des questions et soumettent les décisions clés aux personnes |
| **Agent → Agent** | Les agents délèguent, transmettent les résultats et relaient les questions pour avancer ensemble |

**OSA intègre la collaboration Agent to Agent à votre environnement de développement quotidien.** Le Router clarifie les objectifs et distribue le travail. Les Executors planifient, explorent, implémentent et déboguent. Vous donnez la direction ; les agents assurent l'exécution et les relais.

## Pourquoi OSA

- **Une seule entrée, plusieurs tâches.** Décrivez vos objectifs en langage naturel, coordonnez Claude Code, Codex et d'autres agents en parallèle, et recevez leurs rapports dans une boîte commune.
- **Plusieurs ordinateurs, un seul espace de travail.** Le contrôle à distance et la gestion de plusieurs ordinateurs d'Orca donnent accès aux sessions et espaces de travail locaux et distants.
- **La progression en un coup d'œil.** Le panneau latéral natif classe les tâches : Votre intervention, Prêtes, En attente d'événements externes, En cours et Historique. Regroupez-les par projet, espace de travail ou agent.
- **De la vue d'ensemble à la session concernée.** Dépliez une tâche pour consulter les échanges, retrouvez sa fenêtre d'exécution ou cliquez sur `@` pour copier sa référence et poursuivre avec le Router.
- **Un suivi des tâches de longue durée.** Les décisions s'accompagnent de questions précises, les attentes de dates de réexamen, et les affectations comme les rapports conservent une trace pour la suite.

OSA associe la répartition des rôles de dsh-superagent et l'approche par événements et horloges d'autoloop à l'orchestration native, aux espaces visuels et à l'accès distant d'Orca, pour relier les objectifs au travail concret.

## Fonctionnement

```text
Votre objectif → Router : clarification et affectation → Executor : exécution
                          ↑                                  ↓
                  Décisions clés ← Questions, progression, résultats

Orca : fenêtres d'exécution · espaces de travail · boîtes de réception · accès distant
Panneau OSA : consulter les tâches, suivre la progression, ouvrir la session concernée
```

## Démarrage rapide

Préparez Orca et un agent déjà connecté, par exemple Claude Code ou Codex.

1. Placez la [compétence Router](skills/osa-router/SKILL.md) dans le dossier de compétences de l'agent, par exemple `~/.claude/skills/osa-router/SKILL.md`.
2. Placez les [règles des Executors](skills/executor-rules.md) dans `~/osa-team/executor-rules.md`.
3. Depuis la racine du dépôt, exécutez la commande et approuvez les permissions demandées par Orca :

```sh
orca plugin install ./plugin/osa-panel
```

Lancez une tâche dans une fenêtre Orca :

```text
/osa-router Corrige l'échec de connexion de ce projet et vérifie le résultat en local
```

Reprenez une tâche existante :

```text
/osa-router resume <nom-de-la-tâche>
```

## Pour aller plus loin

Les guides détaillés ci-dessous sont en chinois.

- [Panneau des tâches](plugin/osa-panel/README.md) : consulter, rechercher, localiser et suivre les tâches.
- [Philosophie de conception](docs/000-philosophy.md) : rôles du Router et des Executors.
- [Suivi des états](docs/009-state-watch.md) : réexamen et reprise automatique, notes d'implémentation.
- [Agents et canaux](docs/010-agents-and-channels.md) : préférences et orientations pour GitHub et Feishu.
- [Correctifs Orca associés](patches/README.md) : versions et utilisation.

Partagez vos usages, problèmes et suggestions dans les [Issues](https://github.com/David0Ming/Orca-superagent/issues).

## Remerciements et licence

Merci à [dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype), [Orca](https://github.com/stablyai/orca) et [agent-autoloop](https://github.com/KKKKhazix/agent-autoloop) pour leurs idées, interfaces et réalisations.

Le code et la documentation d'OSA sont sous [PolyForm Noncommercial 1.0.0](LICENSE), qui autorise l'utilisation, la modification et la distribution non commerciales. Les correctifs dérivés d'Orca dans `patches/` sont sous [MIT](patches/LICENSE.orca).
