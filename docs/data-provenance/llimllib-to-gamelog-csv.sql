-- DuckDB: convert llimllib/nba_data v1 player + team game logs into the CSV contract
-- read by server/src/services/sportsData/gameLogAdapter.js (season = start year).
-- Usage (run from the folder holding the two parquet files):
--   duckdb -c ".read llimllib-to-gamelog-csv.sql"
-- Only seasons whose v1 player logs are complete are selected (2024-25, 2025-26);
-- earlier v1 seasons contain only each season's last 4-15 games.
COPY (
  WITH teamgames AS (
    SELECT game_id, team_id::VARCHAR AS team_id, CAST(game_date AS DATE) AS game_date,
           CAST(substr(season_year, 1, 4) AS INTEGER) AS season, matchup LIKE '% vs. %' AS home
    FROM 'gamelogs.parquet'
    WHERE substr(game_id, 1, 3) = '002' AND season_year IN ('2024-25', '2025-26')
  )
  SELECT p.gameId AS game_id, t.game_date, t.season, p.personId::VARCHAR AS player_id,
         trim(concat_ws(' ', p.firstName, p.familyName)) AS player_name, p.teamId::VARCHAR AS team_id,
         p.teamTricode AS team_abbreviation, t.home,
         CASE WHEN (p.minutes IS NULL OR p.minutes = '') AND coalesce(p.comment, '') <> '' THEN '0:00' ELSE p.minutes END AS min,
         p.points AS pts, p.reboundsOffensive AS oreb, p.reboundsDefensive AS dreb, p.reboundsTotal AS reb,
         p.assists AS ast, p.steals AS stl, p.blocks AS blk, p.turnovers AS tov, p.foulsPersonal AS pf,
         p.fieldGoalsMade AS fgm, p.fieldGoalsAttempted AS fga, p.threePointersMade AS fg3m,
         p.threePointersAttempted AS fg3a, p.freeThrowsMade AS ftm, p.freeThrowsAttempted AS fta
  FROM 'player_game_logs.parquet' p
  JOIN teamgames t ON t.game_id = p.gameId AND t.team_id = p.teamId::VARCHAR
  WHERE substr(p.gameId, 1, 3) = '002'
  ORDER BY t.game_date, p.gameId, p.personId
) TO 'llimllib_regular_2024_2025.csv' (HEADER);
