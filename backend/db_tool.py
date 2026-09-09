#!/usr/bin/env python3
"""Small CLI to run SQL against the Blue Ocean Supabase Postgres.
Usage: python db_tool.py "<sql>"            -> prints rows as TSV
       python db_tool.py --file migration.sql
"""
import sys, os, io, psycopg2
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

def conn():
    return psycopg2.connect(
        host="aws-1-eu-west-1.pooler.supabase.com", port=5432, dbname="postgres",
        user="postgres.bfoagnqjkoqhogxvkvkw", password=os.environ["SB_PW"],
        sslmode="require", connect_timeout=15)

def main():
    pw = "Devsura1995@"
    os.environ["SB_PW"] = pw
    sql = open(sys.argv[2], encoding="utf-8").read() if sys.argv[1] == "--file" else sys.argv[1]
    c = conn(); c.autocommit = False
    cur = c.cursor()
    try:
        cur.execute(sql)
        if cur.description:
            cols = [d[0] for d in cur.description]
            print("\t".join(cols))
            for row in cur.fetchall():
                print("\t".join("" if v is None else str(v)[:120] for v in row))
        else:
            print(f"OK, rowcount={cur.rowcount}")
        c.commit()
    except Exception as e:
        c.rollback()
        print("SQL ERROR:", str(e)[:500]); sys.exit(1)
    finally:
        c.close()

if __name__ == "__main__":
    main()
