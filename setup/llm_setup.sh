#!/bin/bash

echo "=== Environment Setup Script (Ollama & Zstd) ==="

# 1. Check and install zstd (Ubuntu/Debian)
if ! command -v zstd &> /dev/null
then
    echo "zstd is not installed. Installing now (this requires sudo privileges)..."
    sudo apt-get update
    sudo apt-get install -y zstd
else
    echo "✅ zstd is already installed."
fi

# 2. Check if Ollama is installed
if ! command -v ollama &> /dev/null
then
    echo "Ollama is not installed. Installing now..."
    # Official Ollama install script for Linux/macOS
    curl -fsSL https://ollama.com/install.sh | sh
else
    echo "✅ Ollama is already installed."
fi

# 3. Check if the Ollama daemon is running, start if necessary
if ! curl -s http://localhost:11434/api/tags > /dev/null; then
    echo "Starting Ollama server in the background..."
    ollama serve > /dev/null 2>&1 &
    
    # Wait a few seconds to let the server initialize
    sleep 3 
else
    echo "✅ Ollama server is running."
fi

# 4. Pull the specific Qwen model
echo "Downloading the qwen2.5:7b model..."
echo "(This may take a few minutes depending on your internet connection)"
ollama pull qwen2.5:7b

echo ""
echo "=== Setup Complete! ==="
echo "You are ready to run your Node.js scripts."