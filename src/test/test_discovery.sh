#!/bin/bash

# Exit immediately if a command exits with a non-zero status
set -e

echo "Starting the discovery pipeline..."

echo "1/5: Fetching Polymarkets data..."
npx ts-node src/discovery/get_polymarkets.ts

echo "2/5: Fetching Kalshi markets data..."
npx ts-node src/discovery/get_kalshimarkets.ts

echo "3/5: Running ETL process..."
npx ts-node src/discovery/etl_markets.ts

echo "4/5: Matching markets..."
npx ts-node src/discovery/market_matcher.ts

echo "----------------------------------------"
echo "Core discovery and matching complete."
echo "----------------------------------------"

# 5: Prompt the user for the checking method
read -p "Which checker would you like to run? Enter 'L' for LLM checker or 'M' for Manual checker: " choice

case "$choice" in 
  [lL]* ) 
    echo "Starting LLM checker..."
    npx tsx src/discovery/llm_checker.ts
    ;;
  [mM]* ) 
    echo "Starting Manual checker..."
    npx tsx src/discovery/manual_checker.ts
    ;;
  * ) 
    echo "No valid selection made. Exiting without running a checker."
    exit 0
    ;;
esac

echo "Pipeline finished!"