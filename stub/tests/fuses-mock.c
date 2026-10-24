#include <stdint.h>
uint32_t hw_fuse_read(uint32_t address){
    if(address==0x4fc00010)return 18;
    if(address==0x4fc00014)return 5;
    if(address==0x40000010)return 5;
    if(address==0x40000014)return 1;
    if(address==0x5012d044)return 0x33445566;
    if(address==0x5012d048)return 0x1122;
    return address^0xa55a1234;
}
