print("Hello, World!")

LEVELS = 5

# Buat segitiga sama segi dengan LEVELS tinggi
for i in range(LEVELS):
    print(' ' * (LEVELS - i - 1) + '*' * (2 * i + 1))
