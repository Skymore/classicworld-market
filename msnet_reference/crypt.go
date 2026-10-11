package crypt

import (
	"crypto/rand"
	"hash/crc32"
)

func ROR1(val byte, num int) byte {
	for range num {
		var lowbit int

		if val&1 > 0 {
			lowbit = 1
		} else {
			lowbit = 0
		}

		val >>= 1
		val |= byte(lowbit << 7)
	}

	return val
}

func ROL1(val byte, num int) byte {
	var highbit int

	for range num {
		if val&0x80 > 0 {
			highbit = 1
		} else {
			highbit = 0
		}

		val <<= 1
		val |= byte(highbit)
	}

	return val
}

func ROL4(value uint32, shift uint32) uint32 {
	return (value << shift) | (value >> (32 - shift))
}

func GenRandomData(dataLen int16) []byte {
	data := make([]byte, dataLen)
	rand.Read(data)
	return data
}

func CalcuChecksum(data []byte) uint32 {
	return crc32.ChecksumIEEE(data)
}
