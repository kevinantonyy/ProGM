# Exploratory diagnostics: top players and ranking mistakes

Exploratory only: these folds were already used to build and compare models.

## Games played: production vs ML (LightGBM), top 60 by production's predicted season total each fold

| group | n | MAE prod | MAE ML | bias prod | bias ML | SD pred prod | SD pred ML | SD actual | corr prod | corr ML |
|---|---|---|---|---|---|---|---|---|---|---|
| top | 540 | 12.60 | 13.77 | +4.78 | +2.78 | 4.96 | 8.29 | 18.24 | 0.231 | 0.172 |
| rest | 2203 | 17.76 | 17.11 | +6.48 | +2.14 | 7.05 | 11.27 | 23.23 | 0.171 | 0.347 |

Reaction to prediction-time availability signals (games per unit change; top tier):

- top: last-season share -> actual 27.6, production 25.7, ML 39.8; last-20-games share -> actual 12.4, ML 12.8; worst-season share -> actual 9.7, ML 14.4
- rest: last-season share -> actual 41.0, production 28.0, ML 40.9; last-20-games share -> actual 16.9, ML 12.2; worst-season share -> actual 14.1, ML 14.3

Descriptive (all folds, not a selection): within the top tier the lowest games MAE is at ML weight 0.0 (MAE 12.60).

## Largest ranking mistakes (top 25 predicted vs finished outside the top 50, and the reverse)

- **production**: 45 early picks finished outside the top 50 (games explain 88% of their shortfall; 27 played under 40 games); 32 top-25 finishers were ranked outside the top 50 (games explain 39%).
- **age_minutes**: 46 early picks finished outside the top 50 (games explain 91% of their shortfall; 29 played under 40 games); 33 top-25 finishers were ranked outside the top 50 (games explain 39%).
- **ml_lgbm**: 49 early picks finished outside the top 50 (games explain 89% of their shortfall; 29 played under 40 games); 43 top-25 finishers were ranked outside the top 50 (games explain 43%).
- **ml_ridge**: 57 early picks finished outside the top 50 (games explain 90% of their shortfall; 35 played under 40 games); 46 top-25 finishers were ranked outside the top 50 (games explain 50%).

Production's misses, with what was known at prediction time (age, last-season share of games, last-20 share, worst season share):

| season | player | pred rank | final rank | pred games | games | pred FP/G | FP/G | age | last share | last-20 | worst |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 2019 | Kevin Durant (early pick) | 15 | 287 | 67 | 0 | 89.8 | nan | 31 | 0.95 | 0.85 | 0.33 |
| 2021 | Kawhi Leonard (early pick) | 24 | 295 | 59 | 0 | 87.3 | nan | 31 | 0.72 | 0.45 | 0.11 |
| 2022 | Miles Bridges (early pick) | 23 | 298 | 70 | 0 | 73.8 | nan | 25 | 0.98 | 1.00 | 0.88 |
| 2025 | Damian Lillard (early pick) | 22 | 302 | 61 | 0 | 86.8 | nan | 35 | 0.71 | 0.35 | 0.35 |
| 2017 | Gordon Hayward (early pick) | 25 | 287 | 71 | 1 | 72.6 | 5.7 | 28 | 0.89 | nan | 0.89 |
| 2019 | Stephen Curry (early pick) | 16 | 272 | 67 | 5 | 88.6 | 76.0 | 32 | 0.84 | 0.90 | 0.62 |
| 2018 | Dwight Howard (early pick) | 15 | 266 | 69 | 9 | 77.2 | 54.2 | 33 | 0.99 | nan | 0.50 |
| 2017 | Kawhi Leonard (early pick) | 14 | 264 | 67 | 9 | 86.8 | 61.3 | 27 | 0.90 | nan | 0.78 |
| 2023 | Ja Morant (early pick) | 17 | 268 | 60 | 9 | 92.4 | 88.8 | 24 | 0.74 | 0.40 | 0.70 |
| 2025 | Trae Young (early pick) | 11 | 243 | 65 | 15 | 89.2 | 63.7 | 27 | 0.93 | 0.90 | 0.66 |
| 2019 | Blake Griffin (early pick) | 19 | 227 | 64 | 18 | 86.2 | 54.9 | 31 | 0.91 | 0.75 | 0.43 |
| 2020 | Hassan Whiteside (early pick) | 20 | 215 | 67 | 36 | 81.4 | 37.3 | 32 | 0.91 | nan | 0.59 |
| 2019 | Bam Adebayo (miss) | 129 | 10 | 63 | 72 | 46.0 | 77.7 | 22 | 1.00 | 1.00 | 0.84 |
| 2022 | Lauri Markkanen (miss) | 111 | 20 | 58 | 66 | 52.9 | 87.5 | 26 | 0.74 | 0.95 | 0.63 |
| 2021 | LaMelo Ball (miss) | 96 | 11 | 51 | 75 | 65.3 | 80.6 | 20 | 0.71 | 0.40 | 0.71 |
| 2024 | Josh Hart (miss) | 95 | 25 | 68 | 77 | 52.5 | 71.0 | 30 | 0.99 | 1.00 | 0.65 |
| 2021 | Miles Bridges (miss) | 92 | 13 | 66 | 80 | 50.9 | 73.8 | 24 | 0.92 | 0.80 | 0.88 |
| 2023 | Tyrese Maxey (miss) | 90 | 21 | 60 | 70 | 60.9 | 83.3 | 23 | 0.73 | 0.85 | 0.73 |
| 2018 | D'Angelo Russell (miss) | 89 | 22 | 60 | 81 | 54.9 | 71.9 | 23 | 0.59 | nan | 0.59 |
| 2017 | Khris Middleton (miss) | 88 | 18 | 65 | 82 | 52.4 | 68.2 | 26 | 0.35 | nan | 0.35 |
| 2019 | Brandon Ingram (miss) | 88 | 23 | 59 | 62 | 59.2 | 79.6 | 22 | 0.63 | 0.05 | 0.63 |
| 2024 | Ivica Zubac (miss) | 84 | 12 | 67 | 80 | 55.3 | 79.2 | 28 | 0.83 | 0.90 | 0.46 |
| 2025 | Amen Thompson (miss) | 83 | 19 | 56 | 79 | 66.8 | 75.7 | 23 | 0.84 | 0.55 | 0.76 |
| 2025 | Kawhi Leonard (miss) | 82 | 18 | 52 | 65 | 73.3 | 92.4 | 35 | 0.45 | 0.70 | 0.11 |

Production's top 25: prediction-time profile of busts (finished outside top 50) vs others:

| bust   |   age_t |   gp_frac_1 |   gp_frac_2 |   worst_gp_frac |   late20_share_1 |   mpg_1 |
|:-------|--------:|------------:|------------:|----------------:|-----------------:|--------:|
| False  |  28.583 |       0.855 |       0.86  |           0.658 |            0.763 |  34.64  |
| True   |  29.267 |       0.847 |       0.842 |           0.598 |            0.752 |  34.202 |
