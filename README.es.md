# Orca-superagent (OSA)

**Varios ordenadores. Varios agentes. Un solo espacio para colaborar.**

Dale un objetivo al Router y deja que los agentes hagan avanzar el trabajo. Sigue el progreso en un panel, accede a los ordenadores remotos con Orca y toma las decisiones clave.

[中文](README.md) · [English](README.en.md) · [Français](README.fr.md) · [Español](README.es.md) · [Русский](README.ru.md) · [العربية](README.ar.md)

## De Human to Human a Agent to Agent

| Colaboración | Cómo avanza el trabajo |
| --- | --- |
| **Human → Human** | Las personas se comunican, reparten el trabajo y se pasan el relevo |
| **Human → Agent** | Una persona describe un objetivo; un agente realiza la tarea |
| **Agent → Human** | Los agentes informan, hacen preguntas y llevan las decisiones clave a las personas |
| **Agent → Agent** | Los agentes delegan tareas, devuelven resultados y transmiten preguntas para avanzar juntos |

**OSA lleva la colaboración Agent to Agent a tu entorno de desarrollo diario.** El Router aclara los objetivos y asigna el trabajo. Los Executors planifican, investigan, implementan y depuran. Tú marcas el rumbo; los agentes se encargan de la ejecución y los relevos.

## Por qué OSA

- **Una entrada, muchas tareas.** Describe objetivos en lenguaje natural, coordina en paralelo agentes como Claude Code y Codex y recibe sus informes en una bandeja común.
- **Varios ordenadores, un solo entorno.** El control remoto y la gestión de varios equipos de Orca permiten acceder a sesiones y espacios de trabajo locales y remotos.
- **El progreso de un vistazo.** El panel lateral nativo organiza las tareas en Requieren tu atención, Listas, Esperando eventos externos, En curso e Historial, agrupadas por proyecto, espacio de trabajo o agente.
- **De la vista general a la sesión concreta.** Despliega una tarea para leer conversaciones y registros, localiza su ventana de ejecución o pulsa `@` para copiar su referencia y continuar con el Router.
- **Seguimiento del trabajo de larga duración.** Las decisiones tienen preguntas concretas, las esperas tienen fechas de revisión y las asignaciones y los informes dejan un registro para continuar.

OSA combina el reparto de roles de dsh-superagent y el enfoque de eventos y temporizadores de autoloop con la orquestación nativa, los espacios visuales y el acceso remoto de Orca, conectando los objetivos con el lugar donde se realiza el trabajo.

## Cómo funciona

```text
Tu objetivo → Router: aclarar y asignar → Executor: ejecutar
                      ↑                         ↓
              Decisiones clave ← Preguntas, progreso y resultados

Orca: ventanas de ejecución · espacios de trabajo · bandejas de entrada · conexiones remotas
Panel OSA: consultar tareas, seguir el progreso y abrir la sesión correspondiente
```

## Primeros pasos

Prepara Orca y un agente con la sesión iniciada, como Claude Code o Codex.

1. Coloca la [habilidad Router](skills/osa-router/SKILL.md) en el directorio de habilidades del agente, por ejemplo `~/.claude/skills/osa-router/SKILL.md`.
2. Coloca las [reglas de los Executors](skills/executor-rules.md) en `~/osa-team/executor-rules.md`.
3. Ejecuta lo siguiente desde la raíz del repositorio y aprueba los permisos que solicite Orca:

```sh
orca plugin install ./plugin/osa-panel
```

Inicia una tarea en una ventana de Orca:

```text
/osa-router Corrige el fallo de inicio de sesión de este proyecto y verifícalo localmente
```

Retoma una tarea existente:

```text
/osa-router resume <nombre-de-la-tarea>
```

## Más información

Las guías detalladas que siguen están en chino.

- [Panel de tareas](plugin/osa-panel/README.md): consultar, buscar, localizar y seguir tareas.
- [Filosofía de diseño](docs/000-philosophy.md): responsabilidades del Router y los Executors.
- [Seguimiento de estados](docs/009-state-watch.md): notas de implementación sobre revisiones y continuación automática.
- [Agentes y canales](docs/010-agents-and-channels.md): preferencias e integración prevista con GitHub y Feishu.
- [Parches complementarios de Orca](patches/README.md): versiones y uso.

Comparte casos de uso, problemas y sugerencias en [Issues](https://github.com/David0Ming/Orca-superagent/issues).

## Agradecimientos y licencia

Gracias a [dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype), [Orca](https://github.com/stablyai/orca) y [agent-autoloop](https://github.com/KKKKhazix/agent-autoloop) por sus ideas, interfaces y trabajo práctico.

El código y la documentación de OSA utilizan [PolyForm Noncommercial 1.0.0](LICENSE), que permite el uso, la modificación y la distribución no comerciales. Los parches derivados de Orca en `patches/` utilizan [MIT](patches/LICENSE.orca).
