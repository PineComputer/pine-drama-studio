{{! A minimal sample template: it shows the format only. Replace its wording with your own. }}
Break episode {{episode}} into segments of {{segment_min_seconds}} to {{segment_max_seconds}} seconds, each one place and one stretch of time, with its shots.

Characters, by id and name:
{{names}}

The bible:
{{bible}}

The episode's script:
{{script}}

The brief:
{{brief}}

{{previous}}
{{feedback}}

Reply with one JSON object in this format:
{{schema}}

Example:
{
  "episode": "{{episode}}",
  "title": "The Letter",
  "segments": [
    {
      "id": "seg01",
      "duration": 8,
      "location": "office",
      "scene_heading": "INT. OFFICE - DAY",
      "characters": [
        "lin"
      ],
      "first_state": "Lin sits at her desk.",
      "shots": [
        {
          "time": "0-8s",
          "size": "medium shot",
          "angle": "eye level",
          "camera": "static camera",
          "view": "base",
          "visual": "At the start: Lin sits at her desk. She opens the letter and reads it.",
          "audio": "Paper rustles.",
          "characters": [
            "lin"
          ]
        }
      ],
      "dialogue": [],
      "must_hit": [
        "Lin opens the letter."
      ],
      "exit_state": "Lin holds the open letter."
    }
  ]
}
