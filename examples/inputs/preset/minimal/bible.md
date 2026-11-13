{{! A minimal sample template: it shows the format only. Replace its wording with your own. }}
Write the story bible of the drama "{{title}}" for {{range}} of the screenplay below: its characters, its places, its beats and its episodes.

The bible so far, as data:
{{previous}}

The brief:
{{brief}}

The screenplay ({{line_count}} lines):
{{screenplay}}

{{feedback}}

Reply with one JSON object in this format:
{{schema}}

Example:
{
  "characters": [
    {
      "id": "lin",
      "name": "Lin",
      "aliases": [],
      "role": "a young reporter",
      "personality": "calm and stubborn",
      "appearance": "short black hair, grey coat",
      "voice": "low and even",
      "observable": true,
      "look": "a grey coat over a white shirt"
    }
  ],
  "scenes": [
    {
      "id": "office",
      "name": "Office",
      "description": "A small newsroom office with one window.",
      "setting": "interior"
    }
  ],
  "beats": [
    {
      "lines": [
        1,
        4
      ],
      "seconds": 6,
      "event": "Lin finds a letter on her desk."
    }
  ],
  "episodes": [
    {
      "id": "EP001",
      "title": "The Letter",
      "summary": "Lin finds an unsigned letter.",
      "end_hook": "Who sent it?"
    }
  ],
  "red_line_issues": []
}
