#!/usr/bin/env python3

import numpy as np
import cbor2
# * temp

# ** temp
GLOB='38'

class Point():
    def __init__(self, x:int=0, y:int=0):
        self.x = x
        self.x = y
        self.serialized = cbor2.dumps([x,y])


class TempC:
    """documentation of tempC
    """
    def __init__(self, a=1, b=3, p:Point =Point()):
        self.a = a
        self.b = b
        self.p = p
    def punintend(self):
        """Documentation of punintend """
        pass
