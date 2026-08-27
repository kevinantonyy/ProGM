"""
FantasyProGM Setup Script
Checks prerequisites, starts MySQL via Docker, seeds the database, 
and starts both backend and frontend dev servers.

Usage: python setup.py
"""
import subprocess
import sys
import time
import os

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
SERVER_DIR = os.path.join(BASE_DIR, 'server')
CLIENT_DIR = os.path.join(BASE_DIR, 'client')


def run(cmd, cwd=None, check=True):
    """Run a shell command and return the result."""
    result = subprocess.run(cmd, shell=True, cwd=cwd or BASE_DIR, 
                          capture_output=True, text=True)
    if check and result.returncode != 0:
        print(f"  ERROR: {result.stderr.strip()}")
        return False
    return result


def check_prerequisites():
    """Check that required tools are installed."""
    print("\n[1/5] Checking prerequisites...")
    
    checks = {
        'node': 'node --version',
        'npm': 'npm --version',
        'docker': 'docker --version',
    }
    
    all_ok = True
    for name, cmd in checks.items():
        result = subprocess.run(cmd, shell=True, capture_output=True, text=True)
        if result.returncode == 0:
            version = result.stdout.strip()
            print(f"  {name}: {version}")
        else:
            print(f"  {name}: NOT FOUND - please install {name}")
            all_ok = False
    
    return all_ok


def start_mysql():
    """Start MySQL container via Docker Compose."""
    print("\n[2/5] Starting MySQL container...")
    
    # Check if already running
    result = subprocess.run('docker ps --filter name=fantasyprogm-db --format "{{.Names}}"',
                          shell=True, capture_output=True, text=True)
    if 'fantasyprogm-db' in result.stdout:
        print("  MySQL container already running.")
        return True
    
    result = run('docker compose up -d')
    if not result:
        print("  Failed to start MySQL. Is Docker running?")
        return False
    
    print("  Waiting for MySQL to be ready...")
    for i in range(30):
        check = subprocess.run(
            'docker exec fantasyprogm-db mysqladmin ping -h localhost -u root -pfantasy123',
            shell=True, capture_output=True, text=True
        )
        if check.returncode == 0:
            print("  MySQL is ready!")
            return True
        time.sleep(2)
    
    print("  MySQL did not become ready in time.")
    return False


def install_dependencies():
    """Install npm dependencies for server and client."""
    print("\n[3/5] Checking dependencies...")
    
    server_ok = os.path.isdir(os.path.join(SERVER_DIR, 'node_modules', 'express'))
    client_ok = os.path.isdir(os.path.join(CLIENT_DIR, 'node_modules', 'react'))
    
    if not server_ok:
        print("  Installing server dependencies...")
        run('npm install', cwd=SERVER_DIR, check=False)
    else:
        print("  Server dependencies: OK")
    
    if not client_ok:
        print("  Installing client dependencies...")
        run('npm install', cwd=CLIENT_DIR, check=False)
    else:
        print("  Client dependencies: OK")
    
    return True


def seed_database():
    """Run the database seed script."""
    print("\n[4/5] Seeding database...")
    result = subprocess.run('node src/db/seed.js', shell=True, cwd=SERVER_DIR,
                          capture_output=True, text=True)
    if result.returncode == 0:
        print(f"  {result.stdout.strip()}")
        return True
    else:
        print(f"  {result.stderr.strip() or result.stdout.strip()}")
        return False


def start_servers():
    """Start backend and frontend dev servers."""
    print("\n[5/5] Starting development servers...")
    print("  Backend:  http://localhost:3002")
    print("  Frontend: http://localhost:5173")
    print("  \n  Demo login: demo / demo123")
    print("\n  Press Ctrl+C to stop both servers.\n")
    
    backend = subprocess.Popen(
        'node src/index.js', shell=True, cwd=SERVER_DIR
    )
    
    frontend = subprocess.Popen(
        'npx vite', shell=True, cwd=CLIENT_DIR
    )
    
    try:
        backend.wait()
    except KeyboardInterrupt:
        print("\n\nShutting down...")
        backend.terminate()
        frontend.terminate()
        backend.wait()
        frontend.wait()
        print("Done.")


def main():
    print("=" * 50)
    print("  FantasyProGM - NBA AI Trade Advisor Setup")
    print("=" * 50)
    
    if not check_prerequisites():
        print("\nPlease install missing prerequisites and try again.")
        sys.exit(1)
    
    if not start_mysql():
        print("\nFailed to start MySQL. Please check Docker.")
        sys.exit(1)
    
    install_dependencies()
    
    if not seed_database():
        print("\nDatabase seed failed. Check MySQL connection.")
        sys.exit(1)
    
    start_servers()


if __name__ == '__main__':
    main()
