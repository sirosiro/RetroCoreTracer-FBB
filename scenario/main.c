#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <unistd.h>
#include <fcntl.h>
#include <sys/mman.h>

#define Z80_REG_BASE  0x42000000
#define Z80_REG_SIZE  0x1000

#define REG_CTRL   0x00
#define REG_STATUS 0x04
#define REG_CMD    0x08
#define REG_CYCLES 0x0C

int main(int argc, char *argv[]) {
    printf("[RetroCoreTracer-Scenario] Initializing Z80 Studio Scenario Firmware...\n");

    int fd = open("/dev/uio0", O_RDWR);
    if (fd < 0) {
        printf("[RetroCoreTracer-Scenario] /dev/uio0 open failed (trying /dev/mem fallback)\n");
        fd = open("/dev/mem", O_RDWR);
        if (fd < 0) {
            perror("[RetroCoreTracer-Scenario] Failed to open /dev/uio0 and /dev/mem");
            return 1;
        }
    }

    volatile uint32_t *regs = (volatile uint32_t *)mmap(NULL, Z80_REG_SIZE,
                                                        PROT_READ | PROT_WRITE,
                                                        MAP_SHARED, fd, 0);
    if (regs == MAP_FAILED) {
        perror("[RetroCoreTracer-Scenario] mmap failed");
        close(fd);
        return 1;
    }

    printf("[RetroCoreTracer-Scenario] MMIO mapped at %p\n", (void*)regs);

    // Initial status check
    regs[REG_CTRL / 4] = 0x01; // Enable Tracer Bridge
    regs[REG_CMD / 4]  = 0x10; // Start Fibonacci Sequence
    
    printf("[RetroCoreTracer-Scenario] Controller started. CTRL=0x%08X, CMD=0x%08X\n",
           regs[REG_CTRL / 4], regs[REG_CMD / 4]);

    for (int i = 0; i < 5; i++) {
        regs[REG_CYCLES / 4] = i * 4;
        printf("[RetroCoreTracer-Scenario] Heartbeat #%d: Simulated Cycles = %d\n", i + 1, regs[REG_CYCLES / 4]);
        sleep(1);
    }

    printf("[RetroCoreTracer-Scenario] Z80 Studio Scenario Firmware Ready & Running.\n");

    munmap((void*)regs, Z80_REG_SIZE);
    close(fd);
    return 0;
}
