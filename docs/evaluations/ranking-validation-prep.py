import json, sys, duckdb
data, out = sys.argv[1], sys.argv[2]
prior_yy = sys.argv[3] if len(sys.argv) > 3 else '24'
real_yy = sys.argv[4] if len(sys.argv) > 4 else '25'
con = duckdb.connect()
played = "minutes IS NOT NULL AND minutes <> '' AND minutes <> '0:00' AND minutes <> '00:00'"
sql = f"""
WITH g AS (
  SELECT personId::VARCHAR AS id, trim(concat_ws(' ', firstName, familyName)) AS name, substr(gameId,4,2) AS yy, position,
         points, reboundsTotal reb, assists ast, steals stl, blocks blk, turnovers tov
  FROM '{data}/player_game_logs.parquet' WHERE substr(gameId,1,3)='002' AND {played}
),
fp AS (SELECT *, points + 1.2*reb + 1.5*ast + 3*stl + 3*blk - tov AS f FROM g),
prior AS (
  SELECT id, any_value(name) AS pname, count(*) gp, avg(points) pts, avg(reb) reb, avg(ast) ast, avg(stl) stl, avg(blk) blk, avg(tov) tov,
         list_distinct(list(position) FILTER (WHERE position <> '')) AS pos
  FROM fp WHERE yy='{prior_yy}' GROUP BY id
),
real AS (SELECT id, count(*) gp, sum(f) total FROM fp WHERE yy='{real_yy}' GROUP BY id)
SELECT p.*, coalesce(r.gp,0) AS gp_real, coalesce(r.total,0) AS total_real, m.primary
FROM prior p LEFT JOIN real r USING (id)
LEFT JOIN (SELECT id, arg_max(position, n) AS primary FROM (SELECT id, position, count(*) n FROM fp WHERE yy='{prior_yy}' AND position <> '' GROUP BY id, position) GROUP BY id) m USING (id)
WHERE len(p.pos) > 0 AND p.gp >= 15
"""
rows = con.sql(sql).fetchall()
cols = [c[0] for c in con.sql(sql).description]
json.dump([dict(zip(cols, r)) for r in rows], open(out, 'w'), default=float)
print(len(rows), 'players; with any 2025-26 games:', sum(1 for r in rows if r[cols.index('gp_real')] > 0))
