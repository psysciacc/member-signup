#!/usr/bin/env python3
"""One-time import of legacy users.csv into the signups table.

Keeps only id (becomes signups.id / sis_id), email, and created_at.
Legacy rows are inserted as status='approved' with placeholder names,
since they were already-registered members and none of this should
trigger a Canvas enrollment or approval email (that only happens via
the /decision route, which these rows never pass through).

Usage: python3 import_legacy_users.py ~/Downloads/users.csv > import.sql
"""
import csv
import sys

def parse_row(line):
    # Each physical line is one big double-quoted CSV field containing
    # semicolon-delimited subfields, with "" as the escaped quote.
    line = line.strip()
    if not line:
        return None
    # Strip the outer wrapping quotes
    if line.startswith('"') and line.endswith('"'):
        line = line[1:-1]
    parts = line.split(';')
    cleaned = []
    for p in parts:
        p = p.strip()
        if p.startswith('""') and p.endswith('""'):
            p = p[2:-2]
        p = p.replace('""', '"')
        cleaned.append(p)
    return cleaned

def sql_escape(s):
    return s.replace("'", "''")

def main():
    path = sys.argv[1]
    print("BEGIN TRANSACTION;")
    with open(path, encoding='utf-8') as f:
        first = True
        for line in f:
            fields = parse_row(line)
            if not fields:
                continue
            if first:
                first = False
                continue  # header row
            if len(fields) < 8:
                continue
            old_id, email, created_at = fields[0], fields[1], fields[7]
            if not old_id.isdigit() or not email:
                continue
            email = sql_escape(email.strip())
            created_at_iso = created_at.strip().replace(' ', 'T') + 'Z'
            print(
                f"INSERT OR IGNORE INTO signups "
                f"(id, created_at, first_name, last_name, email, notes, "
                f"join_accelerator, join_many_languages, status) VALUES "
                f"({old_id}, '{created_at_iso}', '', '', '{email}', "
                f"'Imported from legacy site', 'No', 'No', 'approved');"
            )
    print("COMMIT;")

if __name__ == '__main__':
    main()
