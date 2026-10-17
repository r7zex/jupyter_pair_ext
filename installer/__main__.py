import sys

if '--manage' in sys.argv:
    sys.argv.remove('--manage')
    from pair_installer.manager import main
else:
    from pair_installer.cli import main

if __name__ == "__main__":
    main()
