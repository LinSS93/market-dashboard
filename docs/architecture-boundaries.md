# Architecture boundaries

Market Dashboard separates three runtime classes:

- **正式 (production):** user-owned watchlists, positions, and the conservative stock-monitor decision contract.
- **Shadow:** research producers, replay, and validation that may observe evidence but cannot create trades or alter live risk actions.
- **兼容 (compatibility):** one-time migrations and historical readers isolated from the active decision path.

Radar / 机会雷达 is always a research-priority layer. Its queue, dossiers, evaluations, feedback experiments, and LLM thesis material do not generate orders and cannot override a risk exit. A fact must be known at its recorded available time before it can be used in validation.
